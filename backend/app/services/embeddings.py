"""Embedding model wrapper. Swap this function to use a different embedding provider."""
import logging
import threading
from collections.abc import Callable

log = logging.getLogger(__name__)

Embedder = Callable[[list[str]], list[list[float]]]


def sentence_transformer_embedder(model_name: str, device: str) -> Embedder:
    model = None
    # Encoding is serialised: concurrent encode() calls crash some GPU backends (e.g. Apple MPS).
    lock = threading.Lock()

    def embed(texts: list[str]) -> list[list[float]]:
        nonlocal model
        with lock:
            if model is None:
                from sentence_transformers import SentenceTransformer  # heavy import, load lazily

                log.info("Loading embedding model %s on %s", model_name, device)
                model = SentenceTransformer(model_name, device=device)
            return model.encode(texts, normalize_embeddings=True, batch_size=32, show_progress_bar=False).tolist()

    return embed
