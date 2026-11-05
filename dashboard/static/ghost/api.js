/* Share RepoQL's existing tab-scoped authorization with the embedded Ghost UI. */
'use strict';
export function ghostFetch(path, options = {}) {
  if (!path.startsWith('/api/ghost/')) throw new TypeError('Invalid Ghost API path');
  const headers = new Headers(options.headers || {});
  let token = null;
  try { token = sessionStorage.getItem('repoql.dashboard.secret'); } catch {}
  if (token) headers.set('Authorization', 'Bearer ' + token);
  if ((options.method || 'GET').toUpperCase() !== 'GET') {
    headers.set('X-Requested-With', 'repoql-dashboard');
  }
  return fetch(path, {...options, headers, cache: 'no-store'});
}
if(typeof window!=='undefined')window.ghostFetch=ghostFetch;
