/* Gravação da reunião — captura, corte em trechos e envio.
 *
 * IIFE, sem framework e sem build, como todo JS deste projeto.
 *
 * O QUE ESTE ARQUIVO RESOLVE, E QUE NÃO É ÓBVIO:
 *
 * 1. MediaRecorder.start(timeslice) NÃO serve para cortar.
 *    Só o primeiro pedaço carrega o cabeçalho do container; os seguintes
 *    não são arquivo de áudio válido sozinhos e o Whisper os recusa. Por
 *    isso aqui o gravador ROTACIONA: stop() (o onstop entrega um arquivo
 *    completo) e start() de novo no mesmo instante.
 *
 * 2. O áudio sobe direto para o Storage, com URL assinada.
 *    A função serverless da Vercel tem limite de corpo de requisição; um
 *    trecho de reunião passa disso. O Flask só autoriza.
 *
 * 3. Safari grava audio/mp4, não webm.
 *    Sem escolher o formato por isTypeSupported, a gravação no iPhone
 *    falha calada — e é do celular que a reunião costuma ser gravada.
 */
(function () {
  "use strict";

  var cfg = window.__REUNIAO__;
  if (!cfg || !cfg.podeGravar) return;

  var painel = document.getElementById("gravador");
  if (!painel) return;

  var btnIniciar = document.getElementById("g-iniciar");
  var btnParar = document.getElementById("g-parar");
  var elRelogio = document.getElementById("g-relogio");
  var elEstado = document.getElementById("g-estado");
  var elNivel = document.getElementById("g-nivel");
  var elAviso = document.getElementById("g-aviso");
  var formEncerrar = document.getElementById("form-encerrar");

  var TRECHO_MS = (cfg.trechoSegundos || 120) * 1000;

  // Ordem de preferência: opus é o mais leve com fala inteligível; mp4 é o
  // que o Safari aceita. O último item é a rede de segurança para navegador
  // que não implementa isTypeSupported.
  var CANDIDATOS = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
  ];

  var stream = null, rec = null, audioCtx = null, analisador = null;
  var gravando = false, encerrandoDepois = false;
  var mime = "", mimeBase = "audio/webm";
  var indice = 0, inicio = 0;
  var timerRodada = null, timerRelogio = null, timerNivel = null;
  var fila = [], enviando = false, falhas = 0;

  function texto(el, t) { if (el) el.textContent = t; }
  function avisar(msg, erro) {
    if (!elAviso) return;
    elAviso.textContent = msg || "";
    elAviso.style.display = msg ? "block" : "none";
    elAviso.className = erro ? "aviso-erro" : "aviso-ok";
  }

  function doisDig(n) { return (n < 10 ? "0" : "") + n; }
  function relogio() {
    var s = Math.floor((Date.now() - inicio) / 1000);
    texto(elRelogio, doisDig(Math.floor(s / 60)) + ":" + doisDig(s % 60));
  }

  function escolherMime() {
    if (!window.MediaRecorder) return null;
    for (var i = 0; i < CANDIDATOS.length; i++) {
      try {
        if (MediaRecorder.isTypeSupported(CANDIDATOS[i])) return CANDIDATOS[i];
      } catch (e) { /* navegador antigo: cai no null abaixo */ }
    }
    return null;
  }

  function json(url, corpo) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpo || {}),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.erro || ("HTTP " + r.status));
        return d;
      });
    });
  }

  // ---------------------------------------------------------------- fila
  // Um trecho por vez. Enviar em paralelo estoura o limite de requisições
  // por minuto do plano gratuito justamente quando a reunião é longa.
  function enfileirar(blob, n) {
    fila.push({ blob: blob, indice: n });
    bombear();
  }

  function bombear() {
    if (enviando || !fila.length) return;
    enviando = true;
    var item = fila[0];

    json(cfg.urlAudio, { indice: item.indice, formato: mimeBase })
      .then(function (d) {
        return fetch(d.url, {
          method: "PUT",
          headers: { "Content-Type": mimeBase, "x-upsert": "true" },
          body: item.blob,
        }).then(function (r) {
          if (!r.ok) throw new Error("upload falhou (HTTP " + r.status + ")");
        });
      })
      .then(function () {
        return json(cfg.urlTranscrever.replace("__N__", item.indice), {
          bytes: item.blob.size,
          duracao_ms: TRECHO_MS,
        });
      })
      .then(function () {
        fila.shift();
        falhas = 0;
        enviando = false;
        atualizarEstado();
        bombear();
        if (!gravando && !fila.length && encerrandoDepois) gerarAta();
      })
      .catch(function (e) {
        enviando = false;
        falhas++;
        // Três tentativas e o trecho sai da fila para não travar os
        // seguintes. Ele continua no banco com status de erro, e o áudio
        // fica no Storage por 30 dias — dá para tentar de novo depois.
        if (falhas >= 3) {
          fila.shift();
          falhas = 0;
          avisar("Um trecho não pôde ser transcrito: " + e.message +
                 " Ele fica guardado; dá para tentar de novo na tela.", true);
        }
        setTimeout(bombear, 4000);
        atualizarEstado();
      });
  }

  function atualizarEstado() {
    var pend = fila.length + (enviando ? 0 : 0);
    if (gravando) {
      texto(elEstado, "Trecho " + (indice + 1) +
            (pend ? " · " + pend + " na fila" : " · em dia"));
    } else if (pend) {
      texto(elEstado, "Enviando os últimos " + pend + " trecho(s)…");
    }
  }

  // ------------------------------------------------------------ rotação
  function iniciarRodada() {
    var pedacos = [];
    rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32000 });

    rec.ondataavailable = function (e) {
      if (e.data && e.data.size) pedacos.push(e.data);
    };
    rec.onstop = function () {
      var blob = new Blob(pedacos, { type: mimeBase });
      if (blob.size > 1000) enfileirar(blob, indice++);
      if (gravando) iniciarRodada();   // rotaciona e segue gravando
      else concluir();
    };

    rec.start();
    timerRodada = setTimeout(function () {
      if (rec && rec.state === "recording") rec.stop();
    }, TRECHO_MS);
  }

  function medirNivel() {
    if (!analisador) return;
    var dados = new Uint8Array(analisador.frequencyBinCount);
    analisador.getByteTimeDomainData(dados);
    var pico = 0;
    for (var i = 0; i < dados.length; i++) {
      pico = Math.max(pico, Math.abs(dados[i] - 128));
    }
    if (elNivel) elNivel.style.width = Math.min(100, (pico / 90) * 100) + "%";
  }

  // -------------------------------------------------------------- início
  function iniciar() {
    mime = escolherMime();
    if (!mime || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      avisar("Este navegador não grava áudio. Use Chrome, Edge ou Safari " +
             "recente, e acesse por HTTPS.", true);
      return;
    }
    mimeBase = mime.split(";")[0];
    btnIniciar.disabled = true;

    navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    }).then(function (s) {
      stream = s;
      return json(cfg.urlIniciar, {});
    }).then(function () {
      gravando = true;
      inicio = Date.now();
      painel.classList.add("gravando");
      btnParar.disabled = false;
      avisar("");

      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        analisador = audioCtx.createAnalyser();
        analisador.fftSize = 512;
        audioCtx.createMediaStreamSource(stream).connect(analisador);
        timerNivel = setInterval(medirNivel, 120);
      } catch (e) { /* medidor é enfeite: sem ele a gravação segue */ }

      timerRelogio = setInterval(relogio, 500);
      relogio();
      atualizarEstado();
      iniciarRodada();
    }).catch(function (e) {
      btnIniciar.disabled = false;
      if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
      avisar("Não foi possível iniciar: " + (e && e.message ? e.message : e) +
             " Verifique a permissão do microfone.", true);
    });
  }

  // ---------------------------------------------------------------- parar
  function parar(comAta) {
    if (!gravando) return;
    encerrandoDepois = !!comAta;
    gravando = false;
    clearTimeout(timerRodada);
    clearInterval(timerRelogio);
    clearInterval(timerNivel);
    btnParar.disabled = true;
    texto(elEstado, "Finalizando o último trecho…");
    if (rec && rec.state === "recording") rec.stop();
    else concluir();
  }

  function concluir() {
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    if (audioCtx) { try { audioCtx.close(); } catch (e) {} audioCtx = null; }
    painel.classList.remove("gravando");
    if (elNivel) elNivel.style.width = "0%";
    atualizarEstado();
    if (!fila.length && !enviando) {
      if (encerrandoDepois) gerarAta();
      else texto(elEstado, "Gravação encerrada. Trechos transcritos.");
    }
  }

  function gerarAta() {
    encerrandoDepois = false;
    texto(elEstado, "Gerando a ata…");
    json(cfg.urlAta, {})
      .then(function () {
        if (formEncerrar) formEncerrar.submit();   // congela e recarrega
        else window.location.reload();
      })
      .catch(function (e) {
        avisar("A gravação foi salva, mas a ata não pôde ser gerada: " +
               e.message + " Use 'Gerar ata' para tentar de novo.", true);
        texto(elEstado, "Transcrição salva; ata pendente.");
      });
  }

  // Sair no meio perde o trecho que ainda não fechou. O aviso do navegador
  // é a única defesa possível — não dá para impedir o fechamento da aba.
  window.addEventListener("beforeunload", function (e) {
    if (!gravando && !fila.length) return;
    e.preventDefault();
    e.returnValue = "";
    return "";
  });

  if (btnIniciar) btnIniciar.addEventListener("click", iniciar);
  if (btnParar) btnParar.addEventListener("click", function () { parar(false); });

  // "Encerrar e gerar ata": para a gravação, espera a fila esvaziar, gera a
  // ata e só então envia o formulário que congela a reunião. Enviar o form
  // primeiro descartaria o trecho que ainda estava no ar.
  if (formEncerrar) {
    formEncerrar.addEventListener("submit", function (e) {
      if (!gravando && !fila.length) return;   // sem gravação, fluxo normal
      e.preventDefault();
      parar(true);
    });
  }
})();
