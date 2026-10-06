import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseManager } from '../../src/store/db.js';
import { indexAllSessions } from '../../src/store/session-indexer.js';
import { registerSessionSearchTool } from '../../src/tools/session-search-tool.js';

async function fixture(variant: 'legacy'|'structured') {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coverage-wait-'));
  const root=path.join(dir,'sessions');fs.mkdirSync(root);
  fs.writeFileSync(path.join(root,'owned.jsonl'),[
    {type:'session',id:'coverage-session',cwd:'/work/coverage',timestamp:'2026-01-01T00:00:00Z'},
    {type:'message',id:'entry',timestamp:'2026-01-01T00:00:01Z',message:{role:'user',content:'coverage needle'}},
    {type:'message',id:'tool-entry',timestamp:'2026-01-01T00:00:02Z',message:{role:'toolResult',toolName:'bash',toolCallId:'call',content:'tool needle'}},
    {type:'message',id:'system-entry',timestamp:'2026-01-01T00:00:03Z',message:{role:'system',content:'service needle'}},
  ].map(x=>JSON.stringify(x)).join('\n')+'\n');
  const manager=new DatabaseManager(dir);await indexAllSessions(manager,root);
  const db=manager.getDb();
  const complete=manager.getSessionRepairState()!;
  const set=(state: any)=>db.prepare("UPDATE extension_metadata SET value=? WHERE key='session_repair_state:v1'").run(JSON.stringify(state));
  let tool: any; registerSessionSearchTool({registerTool(x: any){tool=x;}} as any,manager,{variant},{sessionsDir:root,timeoutMs:2000});
  return {manager,complete,set,tool,cleanup(){manager.close();fs.rmSync(dir,{recursive:true,force:true});}};
}
for(const variant of ['legacy','structured'] as const){
  test(`${variant} waits for coverage publication instead of exposing a transient unavailable error`,async()=>{
    const f=await fixture(variant);f.set({...f.complete,status:'pending',phase:'coverage'});
    let timer: ReturnType<typeof setTimeout>|undefined;let waiting=false;
    try {
      const result=await f.tool.execute('wait',{query:'coverage',role:'user'},undefined,(update: any)=>{
        if(update.details.phase==='waiting_for_coverage'){waiting=true;timer=setTimeout(()=>f.set(f.complete),150);}
      });
      assert.equal(waiting,true);assert.equal(result.details.success,true);assert.equal(result.details.count,1);
      assert.ok(result.content[0].text.includes('entry'));
    }finally{clearTimeout(timer);f.cleanup();}
  });
  test(`${variant} stops waiting if coverage discovers actual repair work`,async()=>{
    const f=await fixture(variant);f.set({...f.complete,status:'running',phase:'coverage'});let timer: ReturnType<typeof setTimeout>|undefined;
    try{
      const result=await f.tool.execute('repair',{query:'coverage'},undefined,(update: any)=>{
        if(update.details.phase==='waiting_for_coverage')timer=setTimeout(()=>f.set({...f.complete,status:'pending',phase:'message_fts'}),100);
      });
      assert.equal(result.isError,true);assert.equal(result.details.error,'session_evidence_unavailable');
    }finally{clearTimeout(timer);f.cleanup();}
  });
  test(`${variant} coverage waiting is cancellable under the original deadline`,async()=>{
    const f=await fixture(variant);f.set({...f.complete,status:'pending',phase:'coverage'});const controller=new AbortController();
    try{
      await assert.rejects(f.tool.execute('cancel',{query:'coverage'},controller.signal,(update: any)=>{
        if(update.details.phase==='waiting_for_coverage')controller.abort();
      }),(error: any)=>error.name==='AbortError');
    }finally{f.cleanup();}
  });
}
test('legacy labels canonical tool results and system messages, not assistant guesses from SQL',async()=>{
  const f=await fixture('legacy');
  try{
    f.manager.getDb().prepare("UPDATE messages SET role='assistant',kind='message',tool_name='stale' WHERE entry_id='tool-entry'").run();
    const tool=await f.tool.execute('tool',{query:'tool needle',include_tool_output:true});
    assert.match(tool.content[0].text,/Tool result.*bash/);assert.doesNotMatch(tool.content[0].text,/🤖 Assistant/);
    const service=await f.tool.execute('service',{query:'service needle',include_service:true});
    assert.match(service.content[0].text,/System/);assert.doesNotMatch(service.content[0].text,/🤖 Assistant/);
  }finally{f.cleanup();}
});

test('coverage without a completing owner uses the existing timeout, not a success or extended budget',async()=>{
  const f=await fixture('legacy');f.set({...f.complete,status:'pending',phase:'coverage'});
  let tool: any;registerSessionSearchTool({registerTool(x: any){tool=x;}} as any,f.manager,{variant:'legacy'},{sessionsDir:path.join(path.dirname(f.manager.getPath()),'sessions'),timeoutMs:500});
  try{await assert.rejects(tool.execute('timeout',{query:'needle'}),(error: any)=>error.code==='SESSION_SEARCH_TIMEOUT' && /coverage verification/.test(error.message));}finally{f.cleanup();}
});

test('legacy source labels cover tool calls, service kinds and unknown roles without guessing',async()=>{
  const {formatLegacySearch}=await import('../../src/store/session-search-output.js');
  for(const [kind,role,label] of [['tool_call','assistant','Tool call'],['compaction','system','Service (compaction)'],['message','unknown','Service']]){
    const text=formatLegacySearch([{sessionId:'session',entryId:'entry',project:'p',role,kind,content:'needle',snippet:'needle',timestamp:'2026-01-01T00:00:00Z'}],1,'needle').content[0].text;
    assert.ok(text.includes(label));assert.ok(!text.includes('🤖 Assistant'));assert.ok(text.includes('session_id=session entry_id=entry'));
  }
});

test('a real managed reopen and fenced coverage verification publish evidence to an already waiting search',async()=>{
  const f=await fixture('legacy');f.manager.close();
  const peer=new DatabaseManager(path.dirname(f.manager.getPath()));peer.setQuickCheckOnOpen(false);
  let verification: Promise<unknown>|undefined;
  try{
    assert.equal(peer.getSessionRepairState()?.phase,'coverage');
    const result=await f.tool.execute('actual-reopen',{query:'coverage',role:'user'},undefined,(update: any)=>{
      if(update.details.phase==='waiting_for_coverage' && !verification)verification=peer.runSessionRepairChunk();
    });
    assert.ok(verification);await verification;assert.equal(peer.getSessionRepairState()?.status,'complete');
    assert.equal(result.details.success,true);assert.equal(result.details.count,1);
  }finally{await verification;peer.close();f.cleanup();}
});
