from __future__ import annotations

from .config import ConfigError, load_config
from .logging import JsonLogger
from .server import SERVICE_NAME, serve


def main() -> None:
    logger = JsonLogger(SERVICE_NAME)
    try:
        config = load_config()
    except ConfigError as error:
        logger.log(
            "error",
            "boot_rejected",
            "system",
            ["CONFIG_INVALID"],
            error_type=type(error).__name__,
        )
        raise SystemExit(2) from error
    serve(config)


if __name__ == "__main__":
    main()
