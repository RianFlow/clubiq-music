"""Configurable club match pages and independent server-side source refresh."""
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
import json
import re
from threading import RLock
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, model_validator
from psycopg.types.json import Jsonb

import darts_feed as feed
from darts_live import normalize_rest, _watch_live_candidate


CLUB_DARTS_SCHEMA = """
ALTER TABLE cms_clubs ADD COLUMN IF NOT EXISTS darts JSONB;
UPDATE cms_clubs SET darts=CASE WHEN slug='barver' THEN
 '{"enabled":true,"leagues":[{"url":"https://portal.3k-darts.com/frontend/events/10/event/1445/phase/2139","name":"Kreisligen 04","assignments":[{"team_key":"A","participant_id":174110},{"team_key":"B","participant_id":174111},{"team_key":"C","participant_id":174112}]},{"url":"https://portal.3k-darts.com/frontend/events/10/event/1460/phase/2154","name":"Kreisklasse 11","assignments":[{"team_key":"D","participant_id":174266}]}]}'::jsonb
 ELSE '{"enabled":false,"leagues":[]}'::jsonb END WHERE darts IS NULL;
ALTER TABLE cms_clubs ALTER COLUMN darts SET DEFAULT '{"enabled":false,"leagues":[]}'::jsonb;
ALTER TABLE cms_clubs ALTER COLUMN darts SET NOT NULL;
CREATE TABLE IF NOT EXISTS cms_darts_snapshots (
 club_id BIGINT PRIMARY KEY REFERENCES cms_clubs(id),
 config_hash CHAR(64) NOT NULL,
 payload JSONB NOT NULL,
 observed_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS cms_darts_reports (
 club_id BIGINT NOT NULL REFERENCES cms_clubs(id), match_id BIGINT NOT NULL,
 config_hash CHAR(64) NOT NULL, payload JSONB NOT NULL,
 PRIMARY KEY(club_id,match_id,config_hash)
);
"""


def source_ids(value):
    try:
        url = urlsplit(value)
        match = re.fullmatch(r"/frontend/events/10/event/([1-9][0-9]{0,7})/phase/([1-9][0-9]{0,7})(?:/group/[1-9][0-9]{0,7})?/?", url.path)
        if (url.scheme != 'https' or url.hostname != 'portal.3k-darts.com' or url.port is not None
                or url.username or url.password or url.query or url.fragment or not match):
            raise ValueError()
        return tuple(map(int, match.groups()))
    except (ValueError, TypeError, AttributeError):
        raise ValueError('Bitte den 3K-Link zum Spielplan der Liga eintragen (mit event und phase).') from None


class Assignment(BaseModel):
    model_config = ConfigDict(extra='forbid')
    team_key: str = Field(min_length=1, max_length=48, pattern=r'^[a-zA-Z0-9][a-zA-Z0-9_-]*$')
    participant_id: int = Field(ge=1, le=99999999)


class LeagueSource(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)
    url: str = Field(max_length=300)
    name: str = Field(default='Liga', min_length=2, max_length=100)
    assignments: list[Assignment] = Field(default_factory=list, max_length=30)

    @model_validator(mode='after')
    def valid(self):
        source_ids(self.url)
        if len({item.participant_id for item in self.assignments}) != len(self.assignments):
            raise ValueError('Jede 3K-Mannschaft kann pro Liga nur einmal zugeordnet werden.')
        if len({item.team_key for item in self.assignments}) != len(self.assignments):
            raise ValueError('Jede Vereinsmannschaft kann pro Liga nur einmal zugeordnet werden.')
        return self


class DartsSettings(BaseModel):
    model_config = ConfigDict(extra='forbid')
    enabled: bool = False
    leagues: list[LeagueSource] = Field(default_factory=list, max_length=8)

    @model_validator(mode='after')
    def valid(self):
        if self.enabled and (not self.leagues or any(not league.assignments for league in self.leagues)):
            raise ValueError('Bitte für jede Liga mindestens eine Mannschaft zuordnen.')
        identities = [source_ids(league.url) for league in self.leagues]
        if len(set(identities)) != len(identities):
            raise ValueError('Diese Liga ist mehrfach eingetragen.')
        keys = [item.team_key for league in self.leagues for item in league.assignments]
        if len(set(keys)) != len(keys):
            raise ValueError('Bitte jede Vereinsmannschaft genau einer Liga zuordnen.')
        return self


def config_hash(config):
    return sha256(json.dumps(config, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def preview_source(url):
    event, phase = source_ids(url)
    rounds = feed._public_get(f'{feed.API}/{event}/phase/{phase}').get('rounds') or []
    rows = feed._official_standings(feed._public_get(f'{feed.API}/{event}/phase/0/round/0/table'), set())
    if not rounds or not rows:
        raise ValueError('Für diesen Link wurden keine Liga-Spieltage und Mannschaften gefunden.')
    return {'event': event, 'phase': phase, 'roundCount': len(rounds),
            'teams': [{'id': row['id'], 'name': row['name']} for row in rows]}


def collect_season(config, names, now=None):
    now = now or datetime.now(timezone.utc)
    leagues, matches, teams = [], [], []
    for entry in config['leagues']:
        event, phase = source_ids(entry['url'])
        mapping = {item['participant_id']: item['team_key'] for item in entry['assignments']}
        league = {'key': f'e{event}-p{phase}', 'event': event, 'phase': phase,
                  'name': entry['name'], 'short': entry['name'], 'teams': mapping}
        data = feed._load_league_season(league, now)
        if data.get('degraded') or not data.get('rounds') or not data.get('standings') or any(
                row.get('rankSource') != '3k-placement' or not row.get('rank') for row in data['standings']):
            raise ValueError('Die Liga ist gerade nicht vollständig verfügbar.')
        data['standings'].sort(key=lambda row: (row['rank'], row['name']))
        leagues.append(data); matches.extend(data['matches'])
        table = {row['id']: row for row in data['standings']}
        for participant, key in mapping.items():
            if participant not in table:
                raise ValueError('Die zugeordnete Mannschaft gehört nicht zu dieser Liga.')
            profile = feed._load_team_profile(participant)
            own = [match for match in data['matches'] if key in match.get('barverTeams', [])]
            upcoming = [match for match in own if match['kind'] in {'upcoming', 'live'}]
            finals = [match for match in own if match['kind'] == 'final']
            teams.append({'code': key, 'id': participant, 'name': names.get(key) or profile['name'],
                          'league': data['league'], 'rank': table[participant]['rank'], 'matches': own,
                          'nextMatch': upcoming[0] if upcoming else None, 'lastMatch': finals[-1] if finals else None,
                          'roster': profile['roster'], 'venue': profile['venue'], 'record': feed._team_record(own, key)})
    matches = list({(match['eventId'], match['id']): match for match in matches}.values())
    matches.sort(key=lambda match: (match.get('plannedAt') or '', match['id']))
    # Venue lookup is cached by the existing feed; bound the next fixtures to
    # avoid requesting the entire league's address book every five minutes.
    upcoming = [match for match in matches if match['kind'] in {'upcoming', 'live'}][:16]
    home_ids = {match['homeTeamId'] for match in upcoming}
    with ThreadPoolExecutor(max_workers=4) as executor:
        venues = dict(zip(home_ids, executor.map(lambda identifier: feed._load_home_venue(identifier, now), home_ids)))
    for match in upcoming:
        if venues.get(match['homeTeamId']):
            match['homeVenue'] = venues[match['homeTeamId']]
    return {'available': True, 'stale': False, 'updatedAt': now.isoformat(), 'teams': teams,
            'leagues': leagues, 'matches': matches, 'sourceConnection': 'server-worker'}


class ClubDartsWorker:
    """Separate club cache; the existing Barver collector and push hub are retained."""
    def __init__(self, connect, barver_live=None):
        self.connect, self.barver_live = connect, barver_live
        self.lock = RLock()
        self.clubs, self.seasons, self.live, self.errors, self.next_refresh = {}, {}, {}, {}, {}

    def sync(self):
        with self.connect() as conn, conn.cursor() as cur:
            cur.execute('SELECT id,slug,teams,darts FROM cms_clubs WHERE published=TRUE AND darts->>\'enabled\'=\'true\'')
            rows = cur.fetchall()
        current = {row[0]: {'slug': row[1], 'names': {team['key']: team['name'] for team in row[2]}, 'config': row[3]} for row in rows}
        with self.lock:
            old = self.clubs
            for key in set(old) | set(current):
                if key not in current or config_hash(current[key]['config']) != config_hash(old.get(key, {}).get('config', {})):
                    self.seasons.pop(key, None); self.live.pop(key, None); self.next_refresh.pop(key, None); self.errors.pop(key, None)
            self.clubs = current

    def poll(self):
        self.sync()
        with self.lock: clubs = dict(self.clubs)
        for key, club in clubs.items():
            if club['slug'] == 'barver' and club['config'] == json.loads(_BARVER_CONFIG):
                continue  # Barver retains its already running collector.
            now = datetime.now(timezone.utc)
            with self.lock:
                if now.timestamp() < self.next_refresh.get(key, 0): continue
                self.next_refresh[key] = now.timestamp() + 300
            digest = config_hash(club['config'])
            try:
                payload = collect_season(club['config'], club['names'])
                with self.connect() as conn, conn.cursor() as cur:
                    cur.execute('SELECT darts FROM cms_clubs WHERE id=%s AND published=TRUE', (key,))
                    current = cur.fetchone()
                    if not current or config_hash(current[0]) != digest: continue
                    cur.execute('INSERT INTO cms_darts_snapshots(club_id,config_hash,payload,observed_at) VALUES (%s,%s,%s,%s) ON CONFLICT(club_id) DO UPDATE SET config_hash=EXCLUDED.config_hash,payload=EXCLUDED.payload,observed_at=EXCLUDED.observed_at', (key,digest,Jsonb(payload),payload['updatedAt']))
                with self.lock: self.seasons[key] = payload; self.errors.pop(key, None)
            except Exception:
                with self.lock: self.errors[key] = True; self.next_refresh[key] = now.timestamp() + 60

    def season(self, club_id, slug, config):
        if slug == 'barver' and config == json.loads(_BARVER_CONFIG):
            return feed.get_darts_season()
        digest = config_hash(config)
        with self.lock: payload = self.seasons.get(club_id) if self.clubs.get(club_id, {}).get('config') == config else None
        if not payload:
            with self.connect() as conn, conn.cursor() as cur:
                cur.execute('SELECT payload FROM cms_darts_snapshots WHERE club_id=%s AND config_hash=%s', (club_id, digest))
                row = cur.fetchone()
            payload = row[0] if row else None
        if not payload:
            return {'available':False,'stale':True,'teams':[],'leagues':[],'matches':[],
                    'message':'Die 3K-Daten werden auf dem Server vorbereitet. Bitte gleich erneut versuchen.'}
        age = (datetime.now(timezone.utc)-datetime.fromisoformat(payload['updatedAt'])).total_seconds()
        with self.lock: failed = club_id in self.errors
        return {**payload, 'stale': failed or age > 360}

    def poll_live(self):
        with self.lock: clubs = dict(self.clubs)
        for key, club in clubs.items():
            if club['slug'] == 'barver' and club['config'] == json.loads(_BARVER_CONFIG): continue
            payload = self.season(key, club['slug'], club['config'])
            groups = []
            failed = False
            def load(match):
                try:
                    boards = normalize_rest(feed._public_get(f"{feed.LIVE_API}/10/group/{match['id']}/list"))
                    return {'groupKey':str(match['id']),'meta':match,'matches':boards,
                            'connected':True,'stale':False,'finished':match['kind']=='final'}
                except Exception:
                    return None
            candidates = [item for item in payload.get('matches', []) if _watch_live_candidate(item)][:16]
            with ThreadPoolExecutor(max_workers=4) as executor:
                for group in executor.map(load, candidates):
                    if group is None: failed = True
                    else: groups.append(group)
            with self.lock:
                if self.clubs.get(key, {}).get('config') == club['config']:
                    self.live[key] = {'groups':groups,'stale':failed,'updatedAt':datetime.now(timezone.utc).isoformat()}

    def live_snapshot(self, club_id, slug, config):
        if slug == 'barver' and config == json.loads(_BARVER_CONFIG) and self.barver_live:
            return self.barver_live()
        with self.lock:
            if self.clubs.get(club_id, {}).get('config') != config: return {'groups':[]}
            return self.live.get(club_id, {'groups':[]})

    def report(self, club_id, slug, config, match_id):
        season = self.season(club_id, slug, config)
        match = next((item for item in season.get('matches', []) if item['id'] == match_id), None)
        if not match: raise ValueError('Match outside this club')
        if slug == 'barver' and config == json.loads(_BARVER_CONFIG):
            return feed.get_darts_match(match_id)
        digest = config_hash(config)
        with self.connect() as conn, conn.cursor() as cur:
            cur.execute('SELECT payload FROM cms_darts_reports WHERE club_id=%s AND match_id=%s AND config_hash=%s', (club_id,match_id,digest))
            row = cur.fetchone()
        previous = row[0] if row else None
        now = datetime.now(timezone.utc)
        if previous and (now-datetime.fromisoformat(previous['updatedAt'])).total_seconds() < (600 if match['kind']=='final' else 45):
            return {**previous, 'match':match}
        group = next((group for group in self.live_snapshot(club_id,slug,config).get('groups',[]) if group['meta']['id']==match_id), {})
        summary = {'available':True,'stale':bool(season.get('stale')),'match':match,'games':[],
                   'liveGames':group.get('matches',[]),'sourceUrl':match['url'],'reportAvailable':False}
        if match['kind']=='upcoming' and not _watch_live_candidate(match): return summary
        try:
            raw = feed._public_get(f"{feed.API}/{match['eventId']}/match/{match_id}/report")
            if not isinstance(raw,list): raise ValueError('Invalid report')
            payload = {**summary,'updatedAt':now.isoformat(),'stale':False,
                       'games':sorted((feed._public_game(item) for item in raw),key=lambda game:game['number']),
                       'reportAvailable':bool(raw or summary['liveGames'])}
            if payload['reportAvailable']:
                with self.connect() as conn, conn.cursor() as cur:
                    cur.execute('INSERT INTO cms_darts_reports(club_id,match_id,config_hash,payload) VALUES (%s,%s,%s,%s) ON CONFLICT(club_id,match_id,config_hash) DO UPDATE SET payload=EXCLUDED.payload', (club_id,match_id,digest,Jsonb(payload)))
            return payload
        except Exception:
            return {**(previous or summary),'match':match,'stale':True,'reportUnavailable':True}


_BARVER_CONFIG = re.search(r"'(\{\"enabled\":true.*\})'::jsonb", CLUB_DARTS_SCHEMA).group(1)
