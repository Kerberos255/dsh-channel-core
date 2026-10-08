import test from 'node:test';
import assert from 'node:assert/strict';
import {CoreStore} from '../lib/store.js';
import {isOwnerChannelSession} from '../lib/memory-access.js';

const link=(store,provider,accountId,userId,identityId,sessionId,kind='dm')=>{
  store.syncAliases(provider,accountId,[{userId,identityId}]);
  store.putBinding(JSON.stringify([provider,accountId,userId]),{
    sessionId,provider,accountId,userId,kind,scope:{workspaceId:'scope',presetId:'agent'}
  });
};
test('verified Discord and Feishu DMs use same owner identity after explicit linking',()=>{
  const store=new CoreStore(':memory:');
  try{
    link(store,'discord','default','user-discord','my-owner','owned-session');
    link(store,'feishu','default','user-feishu','my-owner','owned-session');
    assert.equal(isOwnerChannelSession(store,'owned-session','my-owner'),true);
    assert.equal(isOwnerChannelSession(store,'owned-session','other-owner'),false);
    assert.equal(isOwnerChannelSession(store,'owned-session',''),false);
  }finally{store.close();}
});
test('unverified DM, strangers and any group binding cannot inherit owner facts',()=>{
 const store=new CoreStore(':memory:');
 try{
  store.putBinding('stranger',{sessionId:'stranger',provider:'discord',accountId:'default',userId:'unknown',kind:'dm',scope:{}});
  assert.equal(isOwnerChannelSession(store,'stranger','my-owner'),false);
  link(store,'discord','default','me','my-owner','group-session','group');
  assert.equal(isOwnerChannelSession(store,'group-session','my-owner'),false);
  link(store,'discord','default','verified','my-owner','mixed');
  store.putBinding('group-mixed',{sessionId:'mixed',provider:'discord',accountId:'default',userId:'verified',kind:'group',scope:{}});
  assert.equal(isOwnerChannelSession(store,'mixed','my-owner'),false);
 }finally{store.close();}
});
test('changing a trusted alias revokes the old memory identity',()=>{
 const store=new CoreStore(':memory:');
 try{
  link(store,'discord','default','u1','my-owner','s1');
  assert.equal(isOwnerChannelSession(store,'s1','my-owner'),true);
  store.syncAliases('discord','default',[]);
  assert.equal(isOwnerChannelSession(store,'s1','my-owner'),false);
 }finally{store.close();}
});
