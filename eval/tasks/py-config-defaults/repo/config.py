import json

DEFAULTS = {"debug": False, "port": 8080, "host": "127.0.0.1"}


def load_config(path):
    with open(path) as f:
        return json.load(f)
