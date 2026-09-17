/* POST /api/logout */
import { json, clearCookie, isLocalHost } from './_lib.js';

export async function onRequestPost({ request }){
  return json({ ok:true }, { headers:{ 'Set-Cookie': clearCookie(!isLocalHost(request.url)) } });
}

