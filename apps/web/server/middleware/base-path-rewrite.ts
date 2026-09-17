export default defineEventHandler((event) => {
  const BASE = '/elden-ring-compass';
  const url = event.node.req.url;
  if (url && url.startsWith(BASE + '/')) {
    event.node.req.url = url.slice(BASE.length) || '/';
  } else if (url === BASE) {
    event.node.req.url = '/';
  }
});
