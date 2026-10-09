// Item validation shared by the REST API and the git ingestor.
export const TYPES = ['SERVICE', 'TOOL', 'FEATURE', 'LIBRARY'];
export const STATUSES = ['ACTIVE', 'DEPRECATED'];
export const SOURCES = ['MANUAL', 'GIT'];

export class ValidationError extends Error {}

// Technology stack: language and framework are lowercase slugs, versions are short free-form tokens.
const NAME_RE = /^[a-z0-9][a-z0-9.+-]{0,39}$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,19}$/;
export const STACK_FIELDS = {
  language: { re: NAME_RE, label: 'El lenguaje', invalid: 'inválido' },
  languageVersion: { re: VERSION_RE, label: 'La versión del lenguaje', invalid: 'inválida' },
  framework: { re: NAME_RE, label: 'El framework', invalid: 'inválido' },
  frameworkVersion: { re: VERSION_RE, label: 'La versión del framework', invalid: 'inválida' },
};

/** Validates one stack value (also used for the API filters). Returns the value or throws ValidationError. */
export function validateStackValue(key, value) {
  const field = STACK_FIELDS[key];
  if (typeof value !== 'string') {
    throw new ValidationError(`${field.label} debe ser texto (los números van entre comillas, por ejemplo "21")`);
  }
  if (!field.re.test(value)) {
    const hint = field.re === NAME_RE
      ? 'solo minúsculas, números, ".", "+" o "-", hasta 40 caracteres'
      : 'solo letras, números, ".", "+" o "-", hasta 20 caracteres';
    throw new ValidationError(`${field.label} es ${field.invalid} (${hint})`);
  }
  return value;
}

function validateStack(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('El stack debe ser un objeto');
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(STACK_FIELDS, key)) {
      throw new ValidationError(`Campo desconocido "${key}" en stack (permitidos: ${Object.keys(STACK_FIELDS).join(', ')})`);
    }
  }
  const stack = {};
  for (const key of Object.keys(STACK_FIELDS)) {
    const v = value[key];
    if (v === undefined || v === null || v === '') continue;
    stack[key] = validateStackValue(key, v);
  }
  return Object.keys(stack).length > 0 ? stack : null;
}

function optionalString(value, label, max) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new ValidationError(`${label} debe ser texto`);
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > max) throw new ValidationError(`${label} no puede superar ${max} caracteres`);
  return trimmed;
}

function requiredString(value, label, max, article = 'El') {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${article} ${label} es obligatorio`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new ValidationError(`${article} ${label} no puede superar ${max} caracteres`);
  }
  return trimmed;
}

function optionalUrl(value, label) {
  const url = optionalString(value, label, 2000);
  if (url !== null && !/^https?:\/\/\S+$/i.test(url)) {
    throw new ValidationError(`${label} debe comenzar con http:// o https://`);
  }
  return url;
}

export function validateItem(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Cuerpo de solicitud inválido');
  }
  const name = requiredString(body.name, 'nombre', 120);
  if (typeof body.type !== 'string' || !TYPES.includes(body.type)) {
    throw new ValidationError('Tipo inválido');
  }
  const description = requiredString(body.description, 'descripción', 1000, 'La');
  const owner = requiredString(body.owner, 'responsable', 200);
  let status = 'ACTIVE';
  if (body.status !== undefined && body.status !== null && body.status !== '') {
    if (!STATUSES.includes(body.status)) throw new ValidationError('Estado inválido');
    status = body.status;
  }
  const repoUrl = optionalUrl(body.repoUrl, 'La URL del repositorio');
  const docsUrl = optionalUrl(body.docsUrl, 'La URL de la documentación');
  const install = optionalString(body.install, 'La instalación', 500);
  const usageExample = optionalString(body.usageExample, 'El ejemplo de uso', 2000);

  const stack = validateStack(body.stack);

  let tags = [];
  if (body.tags !== undefined && body.tags !== null) {
    if (!Array.isArray(body.tags)) throw new ValidationError('Las etiquetas deben ser una lista');
    if (body.tags.length > 20) throw new ValidationError('Máximo 20 etiquetas');
    tags = body.tags.map((t) => {
      if (typeof t !== 'string' || t.trim() === '') {
        throw new ValidationError('Las etiquetas deben ser textos no vacíos');
      }
      const tag = t.trim();
      if (tag.length > 50) throw new ValidationError('Cada etiqueta puede tener hasta 50 caracteres');
      return tag;
    });
  }
  return { name, type: body.type, description, owner, status, repoUrl, docsUrl, install, usageExample, tags, stack };
}
