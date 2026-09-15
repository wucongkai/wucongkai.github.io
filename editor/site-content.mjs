import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import ts from 'typescript';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EditorError } from './content.mjs';

export const sectionFields = {
  about: ['name', 'title', 'description', 'bio', 'github', 'email'],
  projects: ['projects'],
};

export function validateSection(section) {
  if (!Object.hasOwn(sectionFields, section)) throw new EditorError('请选择“项目”或“关于我”。');
  return section;
}

function unwrap(node) {
  while (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

function literal(node) {
  node = unwrap(node);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
  if (ts.isObjectLiteralExpression(node)) {
    const result = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) throw new EditorError('配置包含动态表达式，请先改为普通文本字段。');
      const key = property.name.text;
      if (key === '__proto__' || Object.hasOwn(result, key)) throw new EditorError('配置存在重复或不支持的字段。');
      result[key] = literal(property.initializer);
    }
    return result;
  }
  throw new EditorError('可编辑字段必须是文本或数组，不能包含函数或动态表达式。');
}

function parse(source) {
  const file = ts.createSourceFile('site.config.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (file.parseDiagnostics.length) throw new EditorError('site.config.ts 语法有误，请先修复配置文件。');
  const declarations = file.statements.filter(ts.isVariableStatement).flatMap((statement) => statement.declarationList.declarations);
  const site = declarations.find((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === 'site');
  const object = site?.initializer && unwrap(site.initializer);
  if (!object || !ts.isObjectLiteralExpression(object)) throw new EditorError('未找到 site 配置对象，请保留 export const site = { ... } 结构。');
  const properties = new Map();
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) throw new EditorError('site 配置请使用明确的字段，不能使用展开运算或动态字段。');
    if (properties.has(property.name.text)) throw new EditorError('site 配置中有重复字段。');
    properties.set(property.name.text, property.initializer);
  }
  return { file, properties };
}

export function sectionFromSource(source, section) {
  validateSection(section);
  const { properties } = parse(source);
  const data = {};
  const raw = [];
  for (const key of sectionFields[section]) {
    const node = properties.get(key);
    if (!node) throw new EditorError(`site.config.ts 缺少 ${key} 字段。`);
    data[key] = literal(node);
    raw.push(node.getText());
  }
  return { section, data, version: createHash('sha256').update(JSON.stringify(raw)).digest('hex') };
}

function text(value, label, limit, required = false) {
  if (typeof value !== 'string' || value.length > limit) throw new EditorError(`${label}格式不正确或过长。`);
  if (required && !value.trim()) throw new EditorError(`请填写${label}。`);
  return value.trim();
}

function link(value, label, local = false) {
  value = text(value, label, 2000, true);
  if (/[\u0000-\u0020\u007f\\]/.test(value)) throw new EditorError(`${label}不能含有空格或反斜杠。`);
  if (local && (/^\/(?!\/)/.test(value) || value.startsWith('#'))) return value;
  try {
    const url = new URL(value);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return value;
  } catch { /* Show a human-readable validation error below. */ }
  throw new EditorError(`${label}请填写 http(s) 地址${local ? '、以 / 开头的站内路径或 # 锚点' : ''}。`);
}

export function validateSiteData(section, input) {
  validateSection(section);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new EditorError('内容格式不正确。');
  if (section === 'projects') {
    if (!Array.isArray(input.projects) || input.projects.length > 100) throw new EditorError('项目列表最多支持 100 项。');
    const names = new Set();
    return { projects: input.projects.map((project) => {
      if (!project || typeof project !== 'object' || Array.isArray(project)) throw new EditorError('项目格式不正确。');
      const name = text(project.name, '项目名称', 200, true);
      if (names.has(name)) throw new EditorError('项目名称不能重复，请为项目填写不同的名称。');
      names.add(name);
      return { name, description: text(project.description, '项目简介', 5000), href: link(project.href, '项目链接', true), label: text(project.label, '项目状态', 100) };
    }) };
  }
  if (!Array.isArray(input.bio) || input.bio.length > 100) throw new EditorError('个人介绍最多支持 100 段。');
  const email = text(input.email, '联系邮箱', 254);
  if (email && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw new EditorError('请填写有效的联系邮箱，或留空隐藏。');
  return {
    name: text(input.name, '姓名 / 昵称', 200, true), title: text(input.title, '网站标题', 200, true),
    description: text(input.description, '网站摘要', 2000),
    bio: input.bio.map((paragraph) => text(paragraph, '介绍段落', 20000)).filter(Boolean),
    github: link(input.github, 'GitHub 主页'), email,
  };
}

export function replaceSection(source, section, input) {
  const data = validateSiteData(section, input);
  const { properties, file } = parse(source);
  const edits = sectionFields[section].map((key) => {
    const node = properties.get(key);
    if (!node) throw new EditorError(`site.config.ts 缺少 ${key} 字段。`);
    if (JSON.stringify(literal(node)) === JSON.stringify(data[key])) return null;
    let value = JSON.stringify(data[key], null, 2).replaceAll('\n', '\n  ');
    // Keep the public map callback typed even when every project has been removed.
    if (key === 'projects') value += ' as { name: string; description: string; href: string; label: string }[]';
    return { start: node.getStart(file), end: node.end, value };
  }).filter(Boolean).sort((a, b) => b.start - a.start);
  for (const edit of edits) source = source.slice(0, edit.start) + edit.value + source.slice(edit.end);
  return source;
}

export async function readSiteSource(root) {
  const filename = path.join(root, 'site.config.ts');
  if (!(await fs.lstat(filename)).isFile()) throw new EditorError('网站配置必须是普通文件，不能是符号链接。');
  return fs.readFile(filename, 'utf8');
}

export async function readSiteSection(root, section) {
  return sectionFromSource(await readSiteSource(root), section);
}

export async function saveSiteSection(root, { section, data, version }) {
  const previous = await readSiteSource(root);
  if (sectionFromSource(previous, section).version !== version) throw new EditorError('此部分已在其他窗口或文件中修改。请先复制当前内容留存，再重新载入。', 409);
  const source = replaceSection(previous, section, data);
  const filename = path.join(root, 'site.config.ts');
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, source, { flag: 'wx', mode: (await fs.stat(filename)).mode });
    if (await readSiteSource(root) !== previous) throw new EditorError('保存期间配置文件发生变化，请重试。', 409);
    await fs.rename(temporary, filename);
  } finally { await fs.rm(temporary, { force: true }); }
  return sectionFromSource(source, section);
}

export function previewSiteSection(section, input) {
  const data = validateSiteData(section, input);
  const content = section === 'projects'
    ? h('section', { id: 'projects' }, h('h2', null, '项目'), h('ul', { className: 'project-list' }, data.projects.map((project, index) =>
      h('li', { key: index }, h('div', { className: 'project-title' }, h('a', { href: project.href }, project.name), h('span', { className: 'tag' }, project.label)), h('p', null, project.description)))))
    : h('div', null, h('header', { className: 'page-heading' }, h('h1', null, data.title)),
      h('section', { id: 'about' }, h('h2', null, '关于我'), data.bio.map((paragraph, index) => h('p', { key: index }, paragraph))),
      h('section', { id: 'contact' }, h('h2', null, '联系方式'), h('ul', { className: 'contact-list' },
        data.email && h('li', null, 'Email：', h('a', { href: `mailto:${data.email}` }, data.email)),
        h('li', null, 'GitHub：', h('a', { href: data.github }, data.name)))));
  return '<!doctype html>' + renderToStaticMarkup(h('html', { lang: 'zh-CN' },
    h('head', null, h('meta', { charSet: 'utf-8' }), h('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }),
      h('meta', { httpEquiv: 'Content-Security-Policy', content: "default-src 'none'; style-src 'self'; font-src 'self'; script-src 'none'; base-uri 'none'; form-action 'none'" }),
      h('link', { rel: 'stylesheet', href: '/site.css' }), h('link', { rel: 'stylesheet', href: '/editor.css' })),
    h('body', { className: 'preview-body' }, h('main', { className: 'paper preview-paper site-preview-paper' }, content))));
}
