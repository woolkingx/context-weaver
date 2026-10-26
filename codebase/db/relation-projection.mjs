import { astRelationViewSql } from './ast-relation-projection.mjs';

export const RELATION_PROJECTION_CTES = `
node_view AS MATERIALIZED (
  SELECT name,
         structure,
         behavior,
         json_extract(structure, '$.kind') AS kind,
         COALESCE(
           json_extract(structure, '$.content'),
           json_extract(structure, '$.summary'),
           json_extract(structure, '$.displayName'),
           json_extract(structure, '$.path'),
           name
         ) AS searchable
  FROM nodes
),
edge_view AS MATERIALIZED (
  SELECT e.frompath,
         e.topath,
         COALESCE(e.kind, CASE
           WHEN e.frompath LIKE '%#behavior.%calls.%' THEN 'calls'
           WHEN e.frompath LIKE '%#structure.imports.%' THEN 'imports'
           WHEN e.frompath LIKE '%#structure.classes.%' THEN 'contains'
           WHEN e.frompath LIKE '%#structure.properties.%' THEN 'contains'
           WHEN e.frompath LIKE '%#structure.children.%' THEN 'contains'
           ELSE 'links'
         END) AS relation_kind,
         substr(e.frompath, 1, instr(e.frompath, '#') - 1) AS fromnode,
         substr(e.topath, 1, instr(e.topath, '#') - 1) AS tonode,
         NULL AS from_kind,
         NULL AS to_kind
  FROM edges e
)`;

// These are read-only SQL projections over FileBlock values. The node/edge
// and AST names are query shapes only; none is persisted semantic truth.
export const RELATION_PROJECTION_VIEWS = Object.freeze({
  node_view: `CREATE VIEW node_view AS
    SELECT name, structure, behavior,
           json_extract(structure, '$.kind') AS kind,
           COALESCE(json_extract(structure, '$.content'), json_extract(structure, '$.summary'),
                    json_extract(structure, '$.displayName'), json_extract(structure, '$.path'), name) AS searchable
    FROM nodes`,
  edge_view: `CREATE VIEW edge_view AS
    SELECT e.frompath, e.topath,
           COALESCE(e.kind, CASE
             WHEN e.frompath LIKE '%#behavior.%calls.%' THEN 'calls'
             WHEN e.frompath LIKE '%#structure.imports.%' THEN 'imports'
             WHEN e.frompath LIKE '%#structure.classes.%' OR e.frompath LIKE '%#structure.properties.%' OR e.frompath LIKE '%#structure.children.%' THEN 'contains'
             ELSE 'links' END) AS relation_kind,
           substr(e.frompath, 1, instr(e.frompath, '#') - 1) AS fromnode,
           substr(e.topath, 1, instr(e.topath, '#') - 1) AS tonode,
           NULL AS from_kind, NULL AS to_kind
    FROM edges e`,
  ast_node_view: `CREATE VIEW ast_node_view AS
    WITH ast_tree AS MATERIALIZED (
      SELECT fa.file_path, j.id AS tree_id, j.parent AS parent_tree_id, j.key, j.type, j.value, j.fullkey
      FROM file_ast fa, json_tree(fa.ast, '$.root') j
    )
    SELECT file_path, file_path || '::' || fullkey AS node_id, tree_id AS ast_id,
           fullkey AS ast_path, json_extract(value, '$.kind') AS kind,
           json_extract(value, '$.kindId') AS kind_id, json_extract(value, '$.field') AS field,
           json_extract(value, '$.text') AS text, json_extract(value, '$.start') AS start,
           json_extract(value, '$.end') AS end, json_extract(value, '$.line') AS line,
           json_extract(value, '$.column') AS column, json_extract(value, '$.ordinal') AS ordinal
    FROM ast_tree WHERE type = 'object' AND json_type(value, '$.children') = 'array' AND json_extract(value, '$.kind') IS NOT NULL`,
  ast_edge_view: `CREATE VIEW ast_edge_view AS
    WITH ast_tree AS MATERIALIZED (
      SELECT fa.file_path, j.id AS tree_id, j.parent AS parent_tree_id, j.key, j.type, j.value, j.fullkey
      FROM file_ast fa, json_tree(fa.ast, '$.root') j
    )
    SELECT parent.file_path, parent.file_path || '::' || parent.fullkey AS from_node_id,
           parent.file_path || '::' || parent.fullkey || '.children[' || child.key || ']' AS to_node_id,
           parent.fullkey AS from_path,
           parent.fullkey || '.children[' || child.key || ']' AS to_path, 'ast_contains' AS relation_kind,
           CAST(child.key AS INTEGER) AS ordinal, json_extract(child.value, '$.field') AS field,
           json_extract(child.value, '$.text') AS text,
           json_extract(parent.value, '$.kind') AS from_kind,
           json_extract(child.value, '$.kind') AS to_kind
    FROM ast_tree parent
    JOIN ast_tree children_array ON children_array.file_path = parent.file_path
      AND children_array.parent_tree_id = parent.tree_id AND children_array.key = 'children'
      AND children_array.type = 'array'
    JOIN ast_tree child ON child.file_path = children_array.file_path
      AND child.parent_tree_id = children_array.tree_id AND child.type = 'object'
      AND json_type(child.value, '$.children') = 'array'
      AND json_extract(child.value, '$.kind') IS NOT NULL`,
  ast_relation_view: astRelationViewSql(),
  architecture_view: `CREATE VIEW architecture_view AS
    SELECT 'architecture' AS view_name, fromnode AS from_node_id, tonode AS to_node_id,
           relation_kind, NULL AS file_path, frompath AS source_path, NULL AS ordinal,
           from_kind, to_kind FROM edge_view`,
  workflow_view: `CREATE VIEW workflow_view AS
    SELECT 'workflow' AS view_name, fromnode AS from_node_id, tonode AS to_node_id,
           relation_kind, NULL AS file_path, frompath AS source_path,
           CASE WHEN relation_kind IN ('calls', 'imports')
             THEN CAST(substr(frompath, instr(frompath, '.calls.call') + 11) AS INTEGER)
             ELSE NULL END AS ordinal,
           from_kind, to_kind FROM edge_view
    WHERE relation_kind IN ('calls', 'imports', 'requires', 'depends_on', 'extends', 'follows', 'part_of')`,
  sequence_view: `CREATE VIEW sequence_view AS
    SELECT 'sequence' AS view_name, fromnode AS from_node_id, tonode AS to_node_id,
           relation_kind, NULL AS file_path, frompath AS source_path,
           CAST(substr(frompath, instr(frompath, '.calls.call') + 11) AS INTEGER) AS ordinal,
           from_kind, to_kind FROM edge_view WHERE relation_kind = 'calls'`,
  dataflow_view: `CREATE VIEW dataflow_view AS
    SELECT 'dataflow' AS view_name, e.from_node_id, e.to_node_id, 'ast_contains' AS relation_kind,
           e.file_path, e.to_path AS source_path, e.ordinal, e.from_kind, e.to_kind
    FROM ast_edge_view e
    WHERE e.to_kind IN ('BinaryExpression','CallExpression','ReturnStatement','VariableDeclaration',
                     'PropertyAssignment','ObjectLiteralExpression','ArrayLiteralExpression','AwaitExpression')
    UNION ALL
    SELECT 'dataflow', from_node_id, to_node_id, relation_kind,
           file_path, source_path, ordinal, from_kind, to_kind
    FROM ast_relation_view`,
  lifecycle_view: `CREATE VIEW lifecycle_view AS
    SELECT 'lifecycle' AS view_name, e.from_node_id, e.to_node_id, 'lifecycle' AS relation_kind,
           e.file_path, e.to_path AS source_path, e.ordinal, e.from_kind, e.to_kind
    FROM ast_edge_view e
    WHERE e.to_kind IN ('ClassDeclaration','FunctionDeclaration','MethodDeclaration','Constructor','VariableDeclaration',
                     'PropertyDeclaration','ReturnStatement','ThrowStatement','TryStatement','AwaitExpression')`,
});
