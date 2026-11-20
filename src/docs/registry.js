import { z } from 'zod';

/** Collected route metadata → OpenAPI 3.1 document (INT-06/INT-07). */
const routes = [];

export function registerRoute(r) {
  routes.push(r);
}

const toJson = (schema, io = 'input') => {
  try {
    return z.toJSONSchema(schema, { io, unrepresentable: 'any' });
  } catch {
    return { type: 'object' };
  }
};

const security = {
  public: [],
  optional: [],
  user: [{ cookieAuth: [] }, { bearerAuth: [] }],
  org: [{ cookieAuth: [] }, { bearerAuth: [] }, { apiKey: [] }],
  agent: [{ deviceToken: [] }],
  super: [{ cookieAuth: [] }, { bearerAuth: [] }],
};

export function buildOpenApi() {
  const paths = {};
  for (const r of routes) {
    const full = `/api/v1${r.prefix}${r.path === '/' ? '' : r.path}`.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    const op = {
      tags: [r.tag],
      summary: r.summary ?? '',
      description: [
        r.description,
        r.permission ? `**Permission:** \`${[].concat(r.permission).join(' | ')}\`` : null,
        r.feature ? `**Plan feature:** \`${r.feature}\`` : null,
        r.ids ? `**Features:** ${r.ids}` : null,
      ]
        .filter(Boolean)
        .join('\n\n'),
      security: security[r.auth] ?? [],
      parameters: [],
      responses: {
        200: { description: 'Success' },
        400: { description: 'Validation error' },
        401: { description: 'Unauthenticated' },
        403: { description: 'Forbidden' },
      },
    };
    const pathParams = [...full.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    for (const p of pathParams) op.parameters.push({ name: p, in: 'path', required: true, schema: { type: 'string' } });
    if (r.query) {
      const js = toJson(r.query);
      for (const [name, schema] of Object.entries(js.properties ?? {})) {
        op.parameters.push({ name, in: 'query', required: (js.required ?? []).includes(name), schema });
      }
    }
    if (r.body) op.requestBody = { required: true, content: { 'application/json': { schema: toJson(r.body) } } };
    paths[full] = paths[full] ?? {};
    paths[full][r.method] = op;
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Tracker API',
      version: '1.0.0',
      description:
        'Time Tracking & Productivity Management Platform API. Responses use `{ data, meta? }`; errors use `{ error: { code, message, details } }`.',
    },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: {
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'tr_at' },
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        deviceToken: { type: 'http', scheme: 'bearer', description: 'Desktop agent device token (dt_…)' },
      },
    },
    paths,
  };
}

export const routeCount = () => routes.length;
