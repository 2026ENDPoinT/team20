"""Everytime shared timetable ingestion, without official course matching."""

from .importer import collect, parse_table, save_json

__all__ = ['collect', 'parse_table', 'save_json']
