'use strict';

/**
 * Ban `req.user` from reaching an HTTP response body.
 *
 * `req.user` is a Sequelize User instance hydrated by the auth middleware. Even
 * with a column allowlist it carries account state that is not meant to be
 * public (deletion schedule, email, pending email, permission internals), and
 * any future column is included by default. Responses must name the fields they
 * expose — via a serializer such as publicUserFields — rather than handing the
 * request's user object to res.json().
 *
 * Catches:
 * - res.json(req.user) / res.send(req.user)
 * - res.status(200).json({ user: req.user })
 * - res.json({ ...req.user })
 * - the same through `req.user!` / `req.user as X`
 *
 * Does not track the object through intermediate variables.
 */

const messages = {
  rawUser:
    'Do not put req.user in a response body. Serialize an explicit field allowlist (e.g. publicUserFields) instead.',
  spreadUser:
    'Do not spread req.user into a response body — every current and future User column would be exposed. List the fields explicitly.',
};

/** Response-sending methods whose argument becomes the body. */
const BODY_METHODS = new Set(['json', 'send', 'jsonp']);

/** Identifiers commonly bound to the Express response object. */
const RESPONSE_RECEIVERS = new Set(['res', 'response']);

/** Strip TS-only wrappers so `req.user!` and `req.user as T` are still seen. */
function unwrap(node) {
  let current = node;
  while (
    current &&
    (current.type === 'TSNonNullExpression' ||
      current.type === 'TSAsExpression' ||
      current.type === 'TSTypeAssertion' ||
      current.type === 'ChainExpression')
  ) {
    current = current.expression;
  }
  return current;
}

/** True for `req.user`, `req.user!`, `req?.user`. */
function isRequestUser(node) {
  const target = unwrap(node);
  if (!target || target.type !== 'MemberExpression' || target.computed) return false;
  if (target.property.type !== 'Identifier' || target.property.name !== 'user') return false;
  const object = unwrap(target.object);
  return object && object.type === 'Identifier' && object.name === 'req';
}

/** Walk back through `res.status(200).cookie(...)` to the root identifier. */
function receiverRootName(node) {
  let current = unwrap(node);
  while (current) {
    if (current.type === 'Identifier') return current.name;
    if (current.type === 'MemberExpression') {
      current = unwrap(current.object);
      continue;
    }
    if (current.type === 'CallExpression') {
      current = unwrap(current.callee);
      continue;
    }
    return null;
  }
  return null;
}

function isResponseBodyCall(node) {
  const callee = unwrap(node.callee);
  if (!callee || callee.type !== 'MemberExpression' || callee.computed) return false;
  if (callee.property.type !== 'Identifier') return false;
  if (!BODY_METHODS.has(callee.property.name)) return false;
  const root = receiverRootName(callee.object);
  return root !== null && RESPONSE_RECEIVERS.has(root);
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow sending req.user directly in an HTTP response body',
      recommended: true,
    },
    schema: [],
    messages,
  },

  create(context) {
    /** Report req.user anywhere inside a response body argument. */
    function inspectBody(node, depth) {
      const target = unwrap(node);
      if (!target || depth > 6) return;

      if (isRequestUser(target)) {
        context.report({node: target, messageId: 'rawUser'});
        return;
      }

      if (target.type === 'ObjectExpression') {
        for (const prop of target.properties) {
          if (prop.type === 'SpreadElement') {
            if (isRequestUser(prop.argument)) {
              context.report({node: prop, messageId: 'spreadUser'});
            } else {
              inspectBody(prop.argument, depth + 1);
            }
            continue;
          }
          if (prop.type === 'Property') {
            inspectBody(prop.value, depth + 1);
          }
        }
        return;
      }

      if (target.type === 'ArrayExpression') {
        for (const el of target.elements) {
          if (!el) continue;
          if (el.type === 'SpreadElement') {
            inspectBody(el.argument, depth + 1);
          } else {
            inspectBody(el, depth + 1);
          }
        }
      }
    }

    return {
      CallExpression(node) {
        if (!isResponseBodyCall(node)) return;
        for (const arg of node.arguments) {
          inspectBody(arg, 0);
        }
      },
    };
  },
};
