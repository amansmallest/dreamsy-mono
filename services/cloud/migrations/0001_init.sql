CREATE TABLE games (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  latest INTEGER,
  remix_of TEXT,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX games_owner ON games (owner, updated DESC);

CREATE TABLE versions (
  game TEXT NOT NULL,
  version INTEGER NOT NULL,
  hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  thumb INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  PRIMARY KEY (game, version)
);

CREATE TABLE publications (
  game TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  remix INTEGER NOT NULL DEFAULT 1,
  published INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  plays INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX publications_recent ON publications (hidden, updated DESC);

CREATE TABLE reports (
  slug TEXT NOT NULL,
  reason TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  created INTEGER NOT NULL
);

CREATE TABLE rate (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset INTEGER NOT NULL
);
