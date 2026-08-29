/* Gravação da reunião — captura, corte em trechos e envio.
 *
 * IIFE, sem framework e sem build, como todo JS deste projeto.
 *
 * A TELA: um controle só. O botão da esquerda cicla Gravar → Pausar →
 * Retomar; Concluir aparece na mesma pílula depois que a captura começa e
 * gera a ata sozinho. Não há botão de "gerar ata" no fluxo normal — o que
 * existe no template é resgate para quando a geração automática falhar.
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

  var pill = document.getElementById("g-pill");
  if (!pill) return;

  var btnPrimario = document.getElementById("g-primario");
  var btnConcluir = document.getElementById("g-concluir");
  var elRotulo = document.getElementById("g-rotulo");
  var elRelogio = document.getElementById("g-relogio");
  var elEstado = document.getElementById("g-estado");
  var elAviso = document.getElementById("g-aviso");
  var barras = document.querySelectorAll("#g-onda i");
  var formEncerrar = document.getElementById("form-encerrar");

  var TRECHO_MS = (cfg.trechoSegundos || 120) * 1000;

  var CANDIDATOS = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
  ];

  // parado · gravando · pausado · finalizando · gerando
  var estado = "parado";
  var stream = null, rec = null, audioCtx = null, analisador = null;
  var mime = "", mimeBase = "audio/webm";
  var indice = 0;
  var decorrido = 0, marcaInicio = 0;   // cronômetro que sobrevive à pausa
  var restanteDoTrecho = TRECHO_MS;     // quanto falta para rotacionar
  var timerRodada = null, timerRelogio = null, timerOnda = null;
  var fila = [], enviando = false, falhas = 0;
  var viaFormEncerrar = false;

  function avisar(msg) {
    if (!elAviso) return;
    elAviso.textContent = msg || "";
    elAviso.style.display = msg ? "block" : "none";
  }

  function doisDig(n) { return (n < 10 ? "0" : "") + n; }

  function msDecorridos() {
    return decorrido + (estado === "gravando" ? Date.now() - marcaInicio : 0);
  }

  function pintarRelogio() {
    var s = Math.floor(msDecorridos() / 1000);
    elRelogio.textContent = doisDig(Math.floor(s / 60)) + ":" + doisDig(s % 60);
  }

  var ROTULOS = { parado: "Gravar", gravando: "Pausar", pausado: "Retomar",
                  finalizando: "Finalizando", gerando: "Gerando ata" };

  var cartao = document.getElementById("gravador");

  function render() {
    pill.dataset.estado = estado;
    // Classe no cartão além do `:has()` do CSS: o aviso de microfone aberto é
    // importante demais para depender de um seletor que navegador antigo ignora.
    if (cartao) cartao.classList.toggle("gravando", estado === "gravando");
    elRotulo.textContent = ROTULOS[estado] || "";
    btnPrimario.disabled = (estado === "finalizando" || estado === "gerando");
    btnConcluir.disabled = btnPrimario.disabled;
    pintarRelogio();

    var pend = fila.length;
    if (estado === "gravando" || estado === "pausado") {
      elEstado.textContent = pend ? pend + " trecho(s) na fila" : "Transcrevendo em dia";
    } else if (estado === "finalizando") {
      elEstado.textContent = pend ? "Enviando " + pend + " trecho(s)…" : "Fechando o último trecho…";
    } else if (estado === "gerando") {
      elEstado.textContent = "Gerando a ata…";
    } else {
      elEstado.textContent = indice ? indice + " trecho(s) transcritos." : "";
    }
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
  function enfileirar(blob) {
    fila.push({ blob: blob, indice: indice++ });
    render();
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
          bytes: item.blob.size, duracao_ms: TRECHO_MS,
        });
      })
      .then(function () {
        fila.shift(); falhas = 0; enviando = false;
        render(); bombear(); talvezConcluir();
      })
      .catch(function (e) {
        enviando = false; falhas++;
        // Três tentativas e o trecho sai da fila para não travar os
        // seguintes. Ele continua no banco com status de erro, e o áudio
        // fica no Storage por 30 dias — dá para tentar de novo depois.
        if (falhas >= 3) {
          fila.shift(); falhas = 0;
          avisar("Um trecho não pôde ser transcrito: " + e.message +
                 " Ele fica guardado; dá para tentar de novo na tela.");
        }
        setTimeout(bombear, 4000);
        render(); talvezConcluir();
      });
  }

  // ------------------------------------------------------------ rotação
  function iniciarRodada(ms) {
    var pedacos = [];
    rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32000 });
    rec.ondataavailable = function (e) { if (e.data && e.data.size) pedacos.push(e.data); };
    rec.onstop = function () {
      var blob = new Blob(pedacos, { type: mimeBase });
      if (blob.size > 1000) enfileirar(blob);
      if (estado === "gravando") iniciarRodada(TRECHO_MS);  // rotaciona e segue
      else concluirCaptura();
    };
    rec.start();
    restanteDoTrecho = ms;
    marcaTrecho = Date.now();
    timerRodada = setTimeout(function () {
      if (rec && rec.state === "recording") rec.stop();
    }, ms);
  }

  var marcaTrecho = 0;

  function medirOnda() {
    if (!analisador || !barras.length) return;
    var dados = new Uint8Array(analisador.frequencyBinCount);
    analisador.getByteFrequencyData(dados);
    var passo = Math.floor(dados.length / barras.length);
    for (var i = 0; i < barras.length; i++) {
      var v = dados[i * passo] / 255;
      barras[i].style.height = Math.max(12, Math.min(100, v * 140)) + "%";
    }
  }

  function zerarOnda() {
    for (var i = 0; i < barras.length; i++) barras[i].style.height = "12%";
  }

  // -------------------------------------------------------------- início
  function escolherMime() {
    if (!window.MediaRecorder) return null;
    for (var i = 0; i < CANDIDATOS.length; i++) {
      try {
        if (MediaRecorder.isTypeSupported(CANDIDATOS[i])) return CANDIDATOS[i];
      } catch (e) { /* navegador antigo */ }
    }
    return null;
  }

  function iniciar() {
    mime = escolherMime();
    if (!mime || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      avisar("Este navegador não grava áudio. Use Chrome, Edge ou Safari recente, por HTTPS.");
      return;
    }
    mimeBase = mime.split(";")[0];
    btnPrimario.disabled = true;

    navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    }).then(function (s) {
      stream = s;
      return json(cfg.urlIniciar, {});
    }).then(function () {
      estado = "gravando";
      decorrido = 0;
      marcaInicio = Date.now();
      avisar("");

      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        analisador = audioCtx.createAnalyser();
        analisador.fftSize = 128;
        audioCtx.createMediaStreamSource(stream).connect(analisador);
        timerOnda = setInterval(medirOnda, 90);
      } catch (e) { /* a onda é enfeite: sem ela a gravação segue */ }

      timerRelogio = setInterval(pintarRelogio, 500);
      iniciarRodada(TRECHO_MS);
      render();
    }).catch(function (e) {
      btnPrimario.disabled = false;
      if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
      avisar("Não foi possível iniciar: " + (e && e.message ? e.message : e) +
             " Verifique a permissão do microfone.");
    });
  }

  // -------------------------------------------------------- pausa/retoma
  function pausar() {
    if (estado !== "gravando" || !rec) return;
    // O relógio e a rotação param junto: sem isso um intervalo de pausa longo
    // fecharia trechos vazios e a contagem mediria tempo que não foi gravado.
    decorrido += Date.now() - marcaInicio;
    restanteDoTrecho = Math.max(3000, restanteDoTrecho - (Date.now() - marcaTrecho));
    clearTimeout(timerRodada);
    clearInterval(timerOnda);
    try { rec.pause(); } catch (e) { /* navegador sem pause: segue gravando */ }
    estado = "pausado";
    zerarOnda();
    render();
  }

  function retomar() {
    if (estado !== "pausado" || !rec) return;
    marcaInicio = Date.now();
    marcaTrecho = Date.now();
    try { rec.resume(); } catch (e) { /* idem */ }
    estado = "gravando";
    timerOnda = setInterval(medirOnda, 90);
    timerRodada = setTimeout(function () {
      if (rec && rec.state === "recording") rec.stop();
    }, restanteDoTrecho);
    render();
  }

  // ------------------------------------------------------------ concluir
  function concluir() {
    if (estado !== "gravando" && estado !== "pausado") return;
    decorrido = msDecorridos();
    estado = "finalizando";
    clearTimeout(timerRodada);
    clearInterval(timerRelogio);
    clearInterval(timerOnda);
    zerarOnda();
    render();
    if (rec && rec.state !== "inactive") {
      if (rec.state === "paused") { try { rec.resume(); } catch (e) {} }
      rec.stop();                        // o onstop chama concluirCaptura()
    } else {
      concluirCaptura();
    }
  }

  function concluirCaptura() {
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    if (audioCtx) { try { audioCtx.close(); } catch (e) {} audioCtx = null; }
    render();
    talvezConcluir();
  }

  /** Só fecha quando a captura parou E a fila esvaziou. */
  function talvezConcluir() {
    if (estado !== "finalizando" || fila.length || enviando) return;
    if (!indice) {                       // nada foi gravado
      estado = "parado"; render();
      json(cfg.urlParar, {}).then(function () { window.location.reload(); })
                            .catch(function () {});
      return;
    }
    gerarAta();
  }

  function gerarAta() {
    estado = "gerando";
    render();
    json(cfg.urlAta, {})
      .then(function () {
        if (viaFormEncerrar && formEncerrar) formEncerrar.submit();
        else window.location.reload();
      })
      .catch(function (e) {
        estado = "parado";
        render();
        avisar("A gravação foi salva, mas a ata não pôde ser gerada: " + e.message +
               " Use o botão abaixo para tentar de novo.");
        json(cfg.urlParar, {}).catch(function () {});
      });
  }

  // Sair no meio perde o trecho que ainda não fechou. O aviso do navegador é
  // a única defesa possível — não dá para impedir o fechamento da aba.
  window.addEventListener("beforeunload", function (e) {
    if (estado === "parado" && !fila.length) return;
    e.preventDefault();
    e.returnValue = "";
    return "";
  });

  btnPrimario.addEventListener("click", function () {
    if (estado === "parado") iniciar();
    else if (estado === "gravando") pausar();
    else if (estado === "pausado") retomar();
  });
  btnConcluir.addEventListener("click", function () { concluir(); });

  // "Encerrar reunião" com gravação em andamento: para, gera a ata e só então
  // envia o formulário que congela. Enviar o form primeiro descartaria o
  // trecho que ainda estava no ar.
  if (formEncerrar) {
    formEncerrar.addEventListener("submit", function (e) {
      if (estado === "parado" && !fila.length) return;
      e.preventDefault();
      viaFormEncerrar = true;
      concluir();
    });
  }

  render();
})();
