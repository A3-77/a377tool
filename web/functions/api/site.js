/* =========================================================================
   GET /api/site  —— 首页展示组件的公开配置

   只返回 enabled 的组件；没启用的直接不出现在结果里，前台据此决定渲不渲染。
   配置内容不是敏感信息（就是首页要展示的图和一些视觉参数），所以不需要登录。
   故意不设 Cache-Control —— 后台改完刷新就该看到，别让边缘缓存挡住。

   返回结构是「扁平」的：blocks.gallery 直接就是那份 config，没有 enabled 层
   （前台只关心配置，多一层没用）。注意和 /api/site-admin 的 GET 不一样 ——
   那边要回显开关状态，所以是 { enabled, config }。改接口时别搞混。
   ========================================================================= */
import { ensureTables } from './_ddl.js';
import { json } from './_lib.js';

export async function onRequestGet({ env }){
  if(!env.DB) return json({ ok:false, error:'D1 未绑定' }, { status:500 });

  try{ await ensureTables(env); }
  catch(e){ return json({ ok:false, error:'数据库未就绪：' + e.message }, { status:500 }); }

  let rows;
  try{
    const r = await env.DB.prepare('select kind, enabled, config from site_blocks').all();
    rows = r.results || [];
  }catch(e){
    return json({ ok:false, error:e.message }, { status:500 });
  }

  const blocks = {};
  for(const row of rows){
    if(!row.enabled) continue;
    let config = {};
    try{ config = JSON.parse(row.config || '{}'); }catch(e){ /* 坏 JSON 当空配置，别让首页整个挂掉 */ }
    blocks[row.kind] = config;
  }

  return json({ ok:true, blocks });
}
