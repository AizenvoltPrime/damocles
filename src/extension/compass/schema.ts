export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    name_tokens TEXT NOT NULL,
    qualified_name TEXT NOT NULL UNIQUE,
    file_path TEXT NOT NULL,
    line_start INTEGER NOT NULL,
    line_end INTEGER NOT NULL,
    language TEXT,
    parent_name TEXT,
    params TEXT,
    return_type TEXT,
    modifiers TEXT,
    signature TEXT,
    is_test INTEGER DEFAULT 0,
    file_hash TEXT,
    community_id INTEGER,
    extra TEXT DEFAULT '{}',
    updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    source_qualified TEXT NOT NULL,
    target_qualified TEXT NOT NULL,
    file_path TEXT NOT NULL,
    line INTEGER DEFAULT 0,
    extra TEXT DEFAULT '{}',
    updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS flows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    entry_point_id INTEGER NOT NULL,
    depth INTEGER NOT NULL,
    node_count INTEGER NOT NULL,
    file_count INTEGER NOT NULL,
    criticality REAL NOT NULL DEFAULT 0.0,
    path_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS flow_memberships (
    flow_id INTEGER NOT NULL,
    node_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (flow_id, node_id)
);

CREATE TABLE IF NOT EXISTS communities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    level INTEGER NOT NULL DEFAULT 0,
    parent_id INTEGER,
    cohesion REAL NOT NULL DEFAULT 0.0,
    size INTEGER NOT NULL DEFAULT 0,
    dominant_language TEXT,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
    name, name_tokens, qualified_name, file_path, signature,
    content=nodes, content_rowid=id,
    tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS nodes_fts_ai AFTER INSERT ON nodes BEGIN
    INSERT INTO nodes_fts(rowid, name, name_tokens, qualified_name, file_path, signature)
    VALUES (NEW.id, NEW.name, NEW.name_tokens, NEW.qualified_name, NEW.file_path, NEW.signature);
END;

CREATE TRIGGER IF NOT EXISTS nodes_fts_ad AFTER DELETE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, name, name_tokens, qualified_name, file_path, signature)
    VALUES ('delete', OLD.id, OLD.name, OLD.name_tokens, OLD.qualified_name, OLD.file_path, OLD.signature);
END;

CREATE TRIGGER IF NOT EXISTS nodes_fts_au AFTER UPDATE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, name, name_tokens, qualified_name, file_path, signature)
    VALUES ('delete', OLD.id, OLD.name, OLD.name_tokens, OLD.qualified_name, OLD.file_path, OLD.signature);
    INSERT INTO nodes_fts(rowid, name, name_tokens, qualified_name, file_path, signature)
    VALUES (NEW.id, NEW.name, NEW.name_tokens, NEW.qualified_name, NEW.file_path, NEW.signature);
END;

CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_qualified ON nodes(qualified_name);
CREATE INDEX IF NOT EXISTS idx_nodes_community ON nodes(community_id);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_qualified);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_qualified);
CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);
CREATE INDEX IF NOT EXISTS idx_edges_file ON edges(file_path);
CREATE INDEX IF NOT EXISTS idx_edges_target_kind ON edges(target_qualified, kind);
CREATE INDEX IF NOT EXISTS idx_edges_source_kind ON edges(source_qualified, kind);
CREATE INDEX IF NOT EXISTS idx_edges_composite ON edges(kind, source_qualified, target_qualified);
CREATE INDEX IF NOT EXISTS idx_flows_criticality ON flows(criticality DESC);
CREATE INDEX IF NOT EXISTS idx_flows_entry ON flows(entry_point_id);
CREATE INDEX IF NOT EXISTS idx_flow_memberships_node ON flow_memberships(node_id);
CREATE INDEX IF NOT EXISTS idx_communities_parent ON communities(parent_id);
CREATE INDEX IF NOT EXISTS idx_communities_cohesion ON communities(cohesion DESC);
`;

export function splitIdentifier(name: string): string {
	return name
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
		.replace(/[_\-./\\]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase();
}

export function qualifyName(name: string, filePath: string, parentName?: string): string {
	const normalizedPath = filePath.replace(/\\/g, '/');
	if (parentName) {
		return `${normalizedPath}::${parentName}::${name}`;
	}
	return `${normalizedPath}::${name}`;
}

export function sanitizeFtsQuery(query: string, join: 'AND' | 'OR' = 'AND'): string {
	const cleaned = query
		.replace(/[*(){}[\]<>"^~|]/g, '')
		.replace(/\b(AND|OR|NOT|NEAR)\b/gi, '')
		.trim();

	if (!cleaned) return '""';

	const words = cleaned.split(/\s+/).filter(Boolean);
	const separator = join === 'OR' ? ' OR ' : ' ';
	return words.map(w => `"${w}"`).join(separator);
}
