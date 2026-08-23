-- Cluster ids are local to a GraphEngine and must not collide across chains.
CREATE TABLE clusters_new (
  chain_id     INTEGER NOT NULL,
  id           TEXT NOT NULL,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  member_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chain_id, id)
);
CREATE TABLE cluster_members_new (
  chain_id   INTEGER NOT NULL,
  cluster_id TEXT NOT NULL,
  address    TEXT NOT NULL,
  PRIMARY KEY (chain_id, cluster_id, address),
  FOREIGN KEY (chain_id, cluster_id) REFERENCES clusters_new(chain_id, id) ON DELETE CASCADE
);
INSERT INTO clusters_new (chain_id, id, created_at, member_count)
  SELECT 0, id, created_at, member_count FROM clusters;
INSERT INTO cluster_members_new (chain_id, cluster_id, address)
  SELECT 0, cluster_id, address FROM cluster_members;
DELETE FROM cluster_members_new WHERE chain_id = 0;
DELETE FROM clusters_new WHERE chain_id = 0;
DROP TABLE cluster_members;
DROP TABLE clusters;
ALTER TABLE clusters_new RENAME TO clusters;
ALTER TABLE cluster_members_new RENAME TO cluster_members;
CREATE INDEX idx_cluster_members_address ON cluster_members (chain_id, address);
