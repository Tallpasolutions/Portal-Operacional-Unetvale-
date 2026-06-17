# Entrypoint da Vercel (@vercel/python detecta a variável `app` WSGI).
# Todo o app Flask vive em ../app.
import sys
from pathlib import Path

# Garante que a raiz do projeto está no path (para importar o pacote `app`).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import create_app  # noqa: E402

app = create_app()
