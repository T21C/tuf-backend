'use strict';

/**
 * Require Sequelize User includes to use an explicit attributes allowlist,
 * and ban sensitive User columns from that allowlist.
 *
 * Catches:
 * - { model: User, ... } without attributes
 * - { model: User, attributes: { exclude: [...] } } (denylist is unsafe)
 * - { model: User, attributes: [..., 'password', ...] } (sensitive fields)
 * - include: [User] / include: User (bare model = all columns)
 * - User.findAll / findOne / findByPk with a sensitive column in `attributes`
 *
 * Does not prove safety of attributes referenced via variables/spreads beyond
 * literal string elements that are statically visible.
 */

/** Credential / recovery / PII columns that must never ride along on includes. */
const SENSITIVE_USER_FIELDS = new Set([
  'password',
  'passwordResetToken',
  'passwordResetExpires',
  'passwordResetTokenHash',
  'emailVerifyTokenHash',
  'emailVerifyExpires',
  'email',
  'pendingEmail',
]);

/**
 * Credential material that must not be selected by name in a top-level User
 * query. Reading a hash belongs in services/auth/passwordCredential.ts, which
 * the security config exempts.
 */
const CREDENTIAL_USER_FIELDS = new Set([
  'password',
  'passwordResetToken',
  'passwordResetTokenHash',
  'emailVerifyTokenHash',
]);

const messages = {
  missingAttributes:
    'User includes must set attributes to an explicit allowlist (never load the full User row).',
  excludeForm:
    'User includes must use attributes: [...] allowlist, not attributes: { exclude: [...] } (denylist still leaks sensitive fields by default).',
  sensitiveField:
    "User include must not select sensitive field '{{field}}'. Omit it from attributes.",
  credentialField:
    "Do not select credential column '{{field}}' here. Read password hashes through services/auth/passwordCredential.ts.",
  bareModel:
    'Do not include the User model bare (include: [User]). Use { model: User, attributes: [...] }.',
};

/** Props that mark a `{ model: User }` object as a Sequelize include (vs FK references). */
const INCLUDE_HINT_KEYS = new Set([
  'as',
  'attributes',
  'required',
  'where',
  'include',
  'through',
  'paranoid',
  'separate',
  'limit',
  'order',
  'duplicating',
  'subQuery',
]);

function getPropName(key) {
  if (!key) return null;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  return null;
}

function getStaticString(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis.map((q) => q.value.cooked ?? '').join('');
  }
  return null;
}

/** True when value is the User Sequelize model identifier / MemberExpression.User */
function isUserModelRef(node) {
  if (!node) return false;
  if (node.type === 'Identifier') return node.name === 'User';
  if (node.type === 'MemberExpression' && !node.computed) {
    return node.property.type === 'Identifier' && node.property.name === 'User';
  }
  return false;
}

function getObjectProperty(objectExpression, name) {
  if (!objectExpression || objectExpression.type !== 'ObjectExpression') return null;
  for (const prop of objectExpression.properties) {
    if (prop.type !== 'Property' || prop.computed) continue;
    if (getPropName(prop.key) === name) return prop;
  }
  return null;
}

function collectLiteralAttributeNames(attributesNode, out) {
  if (!attributesNode) return;

  if (attributesNode.type === 'ArrayExpression') {
    for (const el of attributesNode.elements) {
      if (!el) continue;
      if (el.type === 'SpreadElement') {
        collectLiteralAttributeNames(el.argument, out);
        continue;
      }
      const s = getStaticString(el);
      if (s) out.push({name: s, node: el});
    }
    return;
  }

  if (attributesNode.type === 'ObjectExpression') {
    const includeProp = getObjectProperty(attributesNode, 'include');
    if (includeProp) collectLiteralAttributeNames(includeProp.value, out);
  }
}

function reportSensitiveLiterals(context, attributesNode, fields, messageId) {
  const found = [];
  collectLiteralAttributeNames(attributesNode, found);
  for (const {name, node} of found) {
    if (fields.has(name)) {
      context.report({
        node,
        messageId: messageId || 'sensitiveField',
        data: {field: name},
      });
    }
  }
}

/** Skip Sequelize FK `references: { model: User, key: 'id' }` and association defs. */
function isForeignKeyReferenceObject(objectExpression, ancestors) {
  if (getObjectProperty(objectExpression, 'key')) return true;
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const parent = ancestors[i];
    if (parent.type !== 'Property' || parent.computed) continue;
    const name = getPropName(parent.key);
    if (name === 'references' || name === 'belongsTo' || name === 'hasOne' || name === 'hasMany') {
      return true;
    }
  }
  return false;
}

function looksLikeIncludeObject(objectExpression, ancestors) {
  for (const prop of objectExpression.properties) {
    if (prop.type !== 'Property' || prop.computed) continue;
    const name = getPropName(prop.key);
    if (name && INCLUDE_HINT_KEYS.has(name)) return true;
  }
  // `{ model: User }` only — treat as include when nested under `include:`.
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const parent = ancestors[i];
    if (parent.type !== 'Property' || parent.computed) continue;
    if (getPropName(parent.key) === 'include') return true;
  }
  return false;
}

function checkUserIncludeObject(context, objectExpression) {
  const modelProp = getObjectProperty(objectExpression, 'model');
  if (!modelProp || !isUserModelRef(modelProp.value)) return;

  const ancestors = context.sourceCode
    ? context.sourceCode.getAncestors(objectExpression)
    : context.getAncestors();

  if (isForeignKeyReferenceObject(objectExpression, ancestors)) return;
  if (!looksLikeIncludeObject(objectExpression, ancestors)) return;

  const attributesProp = getObjectProperty(objectExpression, 'attributes');
  if (!attributesProp) {
    context.report({node: modelProp.value, messageId: 'missingAttributes'});
    return;
  }

  const attrs = attributesProp.value;

  if (attrs.type === 'ObjectExpression') {
    const excludeProp = getObjectProperty(attrs, 'exclude');
    if (excludeProp) {
      context.report({node: excludeProp, messageId: 'excludeForm'});
      return;
    }
    const includeProp = getObjectProperty(attrs, 'include');
    if (includeProp) {
      // attributes: [] / include: [] is intentional join-only (loads no User columns).
      reportSensitiveLiterals(context, includeProp.value, SENSITIVE_USER_FIELDS);
      return;
    }
    // Unknown object shape — still require a usable allowlist form.
    context.report({node: attrs, messageId: 'excludeForm'});
    return;
  }

  if (attrs.type === 'ArrayExpression') {
    // Empty allowlist is safe (join/filter only; no User columns selected).
    reportSensitiveLiterals(context, attrs, SENSITIVE_USER_FIELDS);
    return;
  }

  // Identifier / CallExpression / etc. — presence of attributes is required;
  // cannot statically verify contents.
}

/** Finder methods whose options object selects columns from the User table. */
const USER_QUERY_METHODS = new Set([
  'findAll',
  'findOne',
  'findByPk',
  'findAndCountAll',
  'findOrCreate',
]);

/** True for `User.findAll(...)` / `models.User.findOne(...)`. */
function isUserQueryCall(node) {
  const callee = node.callee;
  if (!callee || callee.type !== 'MemberExpression' || callee.computed) return false;
  if (callee.property.type !== 'Identifier') return false;
  if (!USER_QUERY_METHODS.has(callee.property.name)) return false;
  return isUserModelRef(callee.object);
}

/**
 * A top-level User query may legitimately load the whole row, or select `email`
 * to send mail, so neither attributes nor the full include denylist applies
 * here — requiring more would only push callers to drop `attributes` and load
 * everything, which is worse. Only credential columns are flagged, to keep
 * "this code reads a password hash or a reset token" a small, greppable set
 * that has to be exempted in .eslintrc.security.cjs to grow.
 */
function checkUserQueryCall(context, node) {
  if (!isUserQueryCall(node)) return;
  for (const arg of node.arguments) {
    if (!arg || arg.type !== 'ObjectExpression') continue;
    const attributesProp = getObjectProperty(arg, 'attributes');
    if (attributesProp) {
      reportSensitiveLiterals(
        context,
        attributesProp.value,
        CREDENTIAL_USER_FIELDS,
        'credentialField',
      );
    }
  }
}

function checkBareUserInInclude(context, includeValue) {
  if (!includeValue) return;

  if (isUserModelRef(includeValue)) {
    context.report({node: includeValue, messageId: 'bareModel'});
    return;
  }

  if (includeValue.type === 'ArrayExpression') {
    for (const el of includeValue.elements) {
      if (!el) continue;
      if (isUserModelRef(el)) {
        context.report({node: el, messageId: 'bareModel'});
      }
    }
  }
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require Sequelize User includes to use an explicit attributes allowlist without sensitive fields',
      recommended: true,
    },
    schema: [],
    messages,
  },

  create(context) {
    return {
      ObjectExpression(node) {
        checkUserIncludeObject(context, node);
      },
      CallExpression(node) {
        checkUserQueryCall(context, node);
      },
      Property(node) {
        if (node.computed || node.kind !== 'init') return;
        if (getPropName(node.key) !== 'include') return;
        checkBareUserInInclude(context, node.value);
      },
    };
  },
};
