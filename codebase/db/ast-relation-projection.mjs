// Codebase-owned raw AST evidence relation contract.
// The caller supplies an ast_tree(file_path, type, value, fullkey) CTE.
export function astRelationCte(name = 'ast_relation_view') {
  return `${name} AS (
  SELECT parent.file_path,
         parent.file_path || '::' || parent.fullkey || '.children[2]' AS from_node_id,
         parent.file_path || '::' || parent.fullkey || '.children[0]' AS to_node_id,
         'assigns' AS relation_kind, parent.fullkey AS source_path, 2 AS ordinal,
         'Identifier' AS from_kind, 'PropertyAccessExpression' AS to_kind,
         json_extract(parent.value, '$.children[2].text') AS from_label,
         'this.' || json_extract(parent.value, '$.children[0].children[2].text') AS to_label
  FROM ast_tree parent
  WHERE parent.type = 'object' AND json_extract(parent.value, '$.kind') = 'BinaryExpression'
    AND json_extract(parent.value, '$.children[1].text') = '='
    AND json_extract(parent.value, '$.children[0].kind') = 'PropertyAccessExpression'
    AND json_extract(parent.value, '$.children[0].children[0].kind') = 'ThisKeyword'
    AND json_extract(parent.value, '$.children[2].kind') = 'Identifier'
  UNION ALL
  SELECT parent.file_path,
         parent.file_path || '::' || parent.fullkey || '.children[1]',
         parent.file_path || '::' || parent.fullkey,
         'constructs', parent.fullkey, 1, 'Identifier', 'NewExpression',
         json_extract(parent.value, '$.children[1].text'),
         'new ' || json_extract(parent.value, '$.children[1].text')
  FROM ast_tree parent
  WHERE parent.type = 'object' AND json_extract(parent.value, '$.kind') = 'NewExpression'
    AND json_extract(parent.value, '$.children[1].kind') = 'Identifier'
  UNION ALL
  SELECT constructed.file_path,
         property.file_path || '::' || property.fullkey,
         constructed.file_path || '::' || constructed.fullkey,
         'injects', constructed.fullkey, json_extract(property.value, '$.ordinal'),
         'ShorthandPropertyAssignment', 'NewExpression',
         json_extract(property.value, '$.children[0].text'),
         'new ' || json_extract(constructed.value, '$.children[1].text')
  FROM ast_tree constructed JOIN ast_tree property
    ON property.file_path = constructed.file_path
   AND property.fullkey LIKE constructed.fullkey || '.children[3].children[0].children[1].children[%]'
  WHERE constructed.type = 'object' AND property.type = 'object'
    AND json_extract(constructed.value, '$.kind') = 'NewExpression'
    AND json_extract(constructed.value, '$.children[3].children[0].kind') = 'ObjectLiteralExpression'
    AND json_extract(property.value, '$.kind') = 'ShorthandPropertyAssignment'
  UNION ALL
  SELECT parent.file_path,
         parent.file_path || '::' || parent.fullkey || '.children[0]',
         parent.file_path || '::' || parent.fullkey,
         'receiver_calls', parent.fullkey, 0, 'PropertyAccessExpression', 'CallExpression',
         'this.' || json_extract(parent.value, '$.children[0].children[0].children[2].text'),
         json_extract(parent.value, '$.children[0].children[2].text')
  FROM ast_tree parent
  WHERE parent.type = 'object' AND json_extract(parent.value, '$.kind') = 'CallExpression'
    AND json_extract(parent.value, '$.children[0].kind') = 'PropertyAccessExpression'
    AND json_extract(parent.value, '$.children[0].children[0].kind') = 'PropertyAccessExpression'
    AND json_extract(parent.value, '$.children[0].children[0].children[0].kind') = 'ThisKeyword'
)`;
}

export function astRelationViewSql() {
  return `CREATE VIEW ast_relation_view AS
    WITH ast_tree AS MATERIALIZED (
      SELECT fa.file_path, j.type, j.fullkey, j.value
      FROM file_ast fa, json_tree(fa.ast, '$.root') j
      WHERE j.type = 'object'
    ), ${astRelationCte('ast_relations')}
    SELECT * FROM ast_relations`;
}
