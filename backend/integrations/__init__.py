"""Modulare, ausschließlich lesende Datenquellen."""
from .base import BaseIntegration, Reading
from .demo import DemoIntegration
from .homeassistant import HomeAssistantIntegration
from .mqtt import MqttIntegration
from .prometheus import PrometheusIntegration

TYPES = {"mqtt": MqttIntegration, "prometheus": PrometheusIntegration,
         "homeassistant": HomeAssistantIntegration, "demo": DemoIntegration}


def build(cfg, datapoints, env, sink, on_status) -> BaseIntegration:
    return TYPES[cfg.type](cfg, datapoints, env, sink, on_status)
