#!/usr/bin/env node
/**
 * Genera los bloques dinámicos del perfil de la organización JOJA-TECH.
 *
 *   - Bloque PROJECTS: repositorios públicos de la org (nombre, descripción, stack, estado).
 *   - Bloque TEAM:     participantes detectados por sus contribuciones + overrides del config.
 *
 * El script solo reemplaza el contenido entre los marcadores
 * `<!-- PROJECTS:START --> ... <!-- PROJECTS:END -->` y
 * `<!-- TEAM:START --> ... <!-- TEAM:END -->` de `profile/README.md`.
 *
 * Si algo falla, NO escribe el archivo: el README queda intacto.
 *
 * Uso:
 *   node scripts/generate_profile.mjs          # escribe profile/README.md
 *   node scripts/generate_profile.mjs --dry    # imprime el resultado sin escribir
 *
 * Variables de entorno:
 *   GITHUB_TOKEN : token (opcional; sube el límite de la API de 60 a 5000 req/h)
 *   ORG          : sobreescribe la organización del config
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DRY = process.argv.includes('--dry');

const API = 'https://api.github.com';
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

const HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'joja-tech-profile',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

/** Llamada a la API de GitHub con manejo de errores explícito. */
async function gh(path) {
  const res = await fetch(`${API}${path}`, { headers: HEADERS });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const hint =
      res.status === 403 || res.status === 429
        ? ' (posible límite de peticiones: define GITHUB_TOKEN)'
        : '';
    throw new Error(`GitHub API ${res.status} en ${path}${hint}\n${body.slice(0, 300)}`);
  }
  return res.json();
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapeHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
/** Añade el tamaño al avatar de GitHub respetando si la URL ya trae query string. */
const avatarUrl = (url, size) => url + (url.includes('?') ? '&' : '?') + `s=${size}`;

async function loadConfig() {
  const raw = await readFile(resolve(ROOT, 'scripts/profile.config.json'), 'utf8');
  return JSON.parse(raw);
}

/** Repos públicos de la organización, sin paginar de más (consumimos todas las páginas). */
async function fetchOrgRepos(org) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const chunk = await gh(`/orgs/${org}/repos?type=public&per_page=100&page=${page}&sort=pushed&direction=desc`);
    all.push(...chunk);
    if (chunk.length < 100) break;
  }
  return all;
}

function selectProjects(repos, cfg) {
  const { pinned = [], exclude = [], excludeArchived = true, excludeForks = true } = cfg.projects;
  const filtered = repos.filter(
    (r) => !exclude.includes(r.name) && !(excludeArchived && r.archived) && !(excludeForks && r.fork),
  );
  const pos = new Map(pinned.map((n, i) => [n, i]));
  return filtered.sort((a, b) => {
    const pa = pos.has(a.name) ? pos.get(a.name) : Infinity;
    const pb = pos.has(b.name) ? pos.get(b.name) : Infinity;
    if (pa !== pb) return pa - pb;
    return new Date(b.pushed_at) - new Date(a.pushed_at);
  });
}

function renderProjects(repos, org) {
  if (repos.length === 0) return '_Todavía no hay repositorios públicos._';

  const rows = repos.map((repo) => {
    const demo = repo.homepage ? ` · [demo](${repo.homepage})` : '';
    const name = `**[${repo.name}](${repo.html_url})**${demo}`;
    const description = cell(repo.description) || '—';
    const language = repo.language
      ? `![${repo.language}](https://img.shields.io/github/languages/top/${org}/${repo.name}?style=flat-square&label=&color=C1662F)`
      : '—';
    const status = [
      `![última actualización](https://img.shields.io/github/last-commit/${org}/${repo.name}?style=flat-square&labelColor=0B1D26&color=4C6470)`,
      `![estrellas](https://img.shields.io/github/stars/${org}/${repo.name}?style=flat-square&labelColor=0B1D26&color=C1662F)`,
      `![issues](https://img.shields.io/github/issues/${org}/${repo.name}?style=flat-square&labelColor=0B1D26&color=9AA9AE)`,
    ].join(' ');
    return `| ${name} | ${description} | ${language} | ${status} |`;
  });

  return [
    '| Proyecto | Descripción | Lenguaje | Estado |',
    '|:---------|:------------|:--------:|:-------|',
    ...rows,
  ].join('\n');
}

async function collectLogins(repos, cfg, org) {
  const { exclude = [], includeExtra = [] } = cfg.team;
  const logins = new Set(includeExtra);

  for (const repo of repos) {
    try {
      const contributors = await gh(`/repos/${org}/${repo.name}/contributors?per_page=100`);
      for (const c of contributors) {
        if (c.type === 'Bot' || /\[bot\]$/i.test(c.login)) continue;
        logins.add(c.login);
      }
    } catch (error) {
      console.warn(`! No se pudieron leer contribuyentes de ${repo.name}: ${error.message.split('\n')[0]}`);
    }
  }

  for (const login of exclude) logins.delete(login);
  return [...logins];
}

async function fetchTeam(logins, cfg) {
  const { order = [], overrides = {} } = cfg.team;
  const users = [];

  for (const login of logins) {
    try {
      users.push(await gh(`/users/${login}`));
    } catch {
      users.push({ login, html_url: `https://github.com/${login}` });
    }
  }

  const pos = new Map(order.map((l, i) => [l, i]));
  return users.sort((a, b) => {
    const pa = pos.has(a.login) ? pos.get(a.login) : Infinity;
    const pb = pos.has(b.login) ? pos.get(b.login) : Infinity;
    if (pa !== pb) return pa - pb;
    return a.login.localeCompare(b.login);
  });
}

function renderTeam(users, cfg) {
  if (users.length === 0) return '_Sin participantes detectados._';

  const { overrides = {} } = cfg.team;
  const perRow = 4;
  const width = Math.floor(100 / perRow);

  const cards = users.map((u) => {
    const login = u.login;
    const name = (u.name || login).trim();
    const url = u.html_url || `https://github.com/${login}`;
    const avatar = avatarUrl(u.avatar_url || `https://github.com/${login}.png`, 200);
    const role = overrides[login]?.role || u.bio || 'Colaborador';
    return [
      `<td align="center" width="${width}%" valign="top">`,
      `  <a href="${url}">`,
      `    <img src="${avatar}" width="96" height="96" alt="${escapeHtml(name)}" /><br />`,
      `    <b>${escapeHtml(name)}</b>`,
      `  </a><br />`,
      `  <sub>${cell(role)}</sub><br />`,
      `  <a href="${url}">@${login}</a>`,
      `</td>`,
    ].join('\n');
  });

  const rows = [];
  for (let i = 0; i < cards.length; i += perRow) {
    rows.push(`<tr>\n${cards.slice(i, i + perRow).join('\n')}\n</tr>`);
  }

  return `<table align="center">\n${rows.join('\n')}\n</table>`;
}

function replaceBlock(readme, name, content) {
  const start = `<!-- ${name}:START -->`;
  const end = `<!-- ${name}:END -->`;
  const re = new RegExp(`${escapeRe(start)}[\\s\\S]*?${escapeRe(end)}`);
  if (!re.test(readme)) {
    throw new Error(`No se encontraron los marcadores ${start} / ${end} en el README.`);
  }
  return readme.replace(re, `${start}\n${content}\n${end}`);
}

async function main() {
  const cfg = await loadConfig();
  const org = process.env.ORG || cfg.org;
  const readmePath = resolve(ROOT, cfg.profileReadme);

  console.log(`→ Organización: ${org}`);
  if (!TOKEN) console.warn('! Sin GITHUB_TOKEN: límite de la API reducido a 60 peticiones por hora.');

  const repos = await fetchOrgRepos(org);
  const projects = selectProjects(repos, cfg);
  console.log(`→ Proyectos públicos: ${projects.length}`);

  const logins = await collectLogins(repos, cfg, org);
  const users = await fetchTeam(logins, cfg);
  console.log(`→ Participantes: ${users.length}`);

  let readme = await readFile(readmePath, 'utf8');
  readme = replaceBlock(readme, 'PROJECTS', renderProjects(projects, org));
  readme = replaceBlock(readme, 'TEAM', renderTeam(users, cfg));

  if (DRY) {
    process.stdout.write(readme);
    console.log('\n(dry-run: no se escribió ningún archivo)');
    return;
  }

  await writeFile(readmePath, readme, 'utf8');
  console.log(`✔ Actualizado ${cfg.profileReadme}`);
}

main().catch((error) => {
  console.error(`✖ ${error.message}`);
  process.exit(1);
});
