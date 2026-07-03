import { spawn } from "node:child_process";
const OPS="add_discussion_comment add_page_comment append_blocks archive_page batch_mixed_blocks create_database create_page create_view delete_block delete_comment delete_view get_block get_block_children get_bot_user get_comment get_data_source get_file_upload get_page get_page_markdown get_self get_user get_view list_comments list_data_source_templates list_data_sources list_file_uploads list_users list_views move_page query_database query_view restore_page search_pages set_page_properties set_page_property set_page_title trash_page update_block update_comment update_data_source update_database update_page_markdown update_view upload_file".split(" ");
const child = spawn("node",["../build/index.js"],{env:{...process.env,NOTION_TOKEN:process.env.NOTION_TOKEN||"ntn_dummy"},stdio:["pipe","pipe","pipe"]});
let buf=""; const pending=new Map(); let id=0;
const rpc=(m,p)=>{const i=++id;child.stdin.write(JSON.stringify({jsonrpc:"2.0",id:i,method:m,params:p})+"\n");return new Promise(r=>pending.set(i,r));};
const notify=(m,p)=>child.stdin.write(JSON.stringify({jsonrpc:"2.0",method:m,params:p})+"\n");
child.stdout.on("data",d=>{buf+=d;let nl;while((nl=buf.indexOf("\n"))>=0){const l=buf.slice(0,nl).trim();buf=buf.slice(nl+1);if(!l)continue;let m;try{m=JSON.parse(l)}catch{continue}if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id)}}});
child.stderr.on("data",()=>{});
await rpc("initialize",{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"b",version:"0"}});
notify("notifications/initialized",{});
const out={};
for(const op of OPS){
  const r=await rpc("tools/call",{name:"notion_describe",arguments:{operation:op}});
  const text=(r.result?.content||[]).map(c=>c.text||"").join("");
  out[op]=text;
}
child.kill();
process.stdout.write(JSON.stringify(out));
process.exit(0);
