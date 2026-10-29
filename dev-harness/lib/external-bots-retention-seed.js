'use strict';
// Synthetic historical data only. Eligibility and all mutations are exercised through production code.
const crypto=require('node:crypto');
const {qqConnection}=require('./external-bot-fixtures');
function retentionSeed() {
  const old=new Date(Date.now()-100*86400000).toISOString(),recent=new Date().toISOString();
  const base={...qqConnection(),appSecretEnv:'',mode:'inbox',ownerSenderId:'',ownerConversationId:'',ownerConversationType:'direct',controlRevision:1};
  const row=(id,kind='inbox',status='sent')=>{
    const text='RECLAIM_PRIVATE_BODY_'+id,messageId='retention_'+id;
    const item={id:'body_'+id,connectionId:base.id,platform:'qq',connectionLabel:base.label,tenantId:base.tenantId,conversationId:'qq_room',senderId:'qq_person',conversationType:'group',text,messageId,eventId:'event_'+id,receivedAt:old,readAt:old,archivedAt:kind==='control'?old:'',sourceKey:JSON.stringify([base.id,base.tenantId,'qq_room',messageId]),contentHash:crypto.createHash('sha256').update(JSON.stringify(['qq_person','group',text])).digest('hex'),control:null,execution:null,delivery:null,replyHistory:[]};
    if(kind==='control'){
      item.control={connectionId:base.id,platform:'qq',appId:base.appId,tenantId:base.tenantId,senderId:'qq_person',conversationId:'qq_room',conversationType:'group',controlRevision:1};
      item.execution={status:'completed',serverInstanceId:'historic_fixture',startedAt:old,finishedAt:old,errorCode:'',replyText:'RECLAIM_PRIVATE_REPLY_'+id,turnSeq:1,actionFailures:0,proposals:0,contractIncomplete:false};
      item.delivery={status,attemptId:'attempt_'+id,messageId:status==='sent'?'platform_'+id:'',errorCode:status==='failed'?'external_delivery.predispatch':status==='cancelled'?'external_channel.delivery_cancelled':'',updatedAt:old,...(status==='cancelled'?{cancelledAt:old}:{})};
    }return item;
  };
  const read=row('read'),sent=row('sent','control'),failed=row('failed','control','failed'),cancelled=row('cancelled','control','cancelled');
  failed.replyHistory=[{attempt:{status:'failed',attemptId:'attempt_failed_original',messageId:'',errorCode:'external_delivery.token_network',updatedAt:old},nextAttemptId:failed.delivery.attemptId,retryRequestId:'retention_seed_retry_000001',requestedAt:old}];
  const unread=row('unread');unread.readAt='';const unknown=row('unknown','control','unknown');unknown.delivery.errorCode='external_channel.delivery_unknown';
  const unresolved=row('unresolved','control');unresolved.execution.proposals=1;
  const fresh=row('recent');fresh.receivedAt=recent;
  return {schema:4,connections:[base],items:[read,sent,failed,cancelled,unread,unknown,unresolved,fresh],retiredConnectionIds:[]};
}
module.exports={retentionSeed};
