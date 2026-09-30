import json
import os

DEFAULTS = {"debug": False, "port": 8080, "host": "127.0.0.1"}


def load_config(path):
    config = dict(DEFAULTS)
    if os.path.exists(path):
        with open(path) as f:
            config.update(json.load(f))
    return config
