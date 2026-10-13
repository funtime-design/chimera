export const message = {"id":7,"thread_id":12,"sender":"alice","recipient":"alice-cloud","subject":"Work","body":"Please read this.","created_at":"2026-10-11"};
export const task = {"key":"T-9","title":"Example work","owner":"alice","repo":"example"};
export const review = {"task_key":"T-9","title":"Example work","owner":"alice","thread_id":12,"pr_url":"https://example.com/pr/9","pr_number":9,"repo":"example","branch":"claude/T-9-example","base":"main","author":"alice-cloud-author","head_sha":"1234567890abcdef"};
export const revertInputs = [{"person":"alice","how":"revert T-9","repo":"example","list":"1. merge commit abcdef0 · deploy live"},{"person":"alice","how":"latest merge","why":"Broken deploy","repo":"example","list":"1. T-9 \"Example\" · https://example.com/pr/9 · merge commit abcdef0 · deploy unknown"}];
export const neutralIdentity = {
 name: 'chimera', owner: 'alice', ownerDisplayName: 'Alice', ownerDisplayText: "Alice's personal bridge", ownerPossessive: 'their', ownerSubject: 'they', ownerObject: 'them',
 exampleDevice: 'alice-laptop', exampleSecondDevice: 'alice-desktop', exampleCloud: 'alice-cloud', exampleSession: 'alice-cloud-x7k-example', exampleRepo: 'example', examplePeer: 'bob',
 baseUrl: 'https://example.com', envPrefix: 'CHIMERA', sessionHeader: 'Chimera-Session', contextHeader: 'Chimera-Context',
 responderAsset: '/chimera-responder.mjs', connectorAsset: '/chimera-mcp.mjs', responderCommand: 'chimera-responder',
 guideTokenStorage: 'kept in the example secret store', guideRoutineSecrets: 'Set each with `wrangler secret put`.',
};
export function renderCases(r,c) {
 const m=message, t=task;
 const toolTexts=r.buildToolDescriptions(c);
 // The original home page uses the first sentence of each top-level tool description.
 const tools=Object.entries(toolTexts).filter(([k])=>!k.includes('_inputSchema')).map(([name,description])=>({name,description}));
 const homeData={origin:c.baseUrl,version:'0.1.0',deployed:null,tools,people:[],standalone:[],claimSeconds:900,onlineSeconds:180,expirySeconds:28800};
 return {
 instructions:r.buildInstructions(c),toolTexts,
 payloads:[r.buildPayload(c,m),r.buildPayload(c,m,t),r.buildPayload(c,m,{...t,repo:null})],
 reviews:[r.buildReviewBrief(c,review),r.buildReviewBrief(c,{...review,author:null}),r.buildReviewBrief(c,{...review,previous:{head_sha:'abcdef012345',url:'https://example.com/session',session_id:'prev'}}),r.buildReviewBrief(c,{...review,head_sha:undefined,previous:{head_sha:'',url:null,session_id:null}})],
 reverts:revertInputs.map(v=>r.buildRevertBrief(v)),
 homes:[r.buildHomePage(c,homeData),r.buildHomePage(c,{...homeData,deployed:'2026-10-11',people:[{name:'alice',online:true,devices:[{name:'alice-laptop',online:false}]}],standalone:[{name:'pipeline',online:true}],claimSeconds:60,onlineSeconds:120,expirySeconds:7200})],
 prompts:[r.buildResponderPrompt(c,'alice-laptop',m,'example',null),r.buildResponderPrompt(c,'alice-laptop',m,'example','owner'),r.buildResponderPrompt(c,'alice-laptop',{...m,subject:null},'example','trusted')],
 mcp:{initialize:r.buildMcpInstructions(c,'alice'),help:r.buildHelpText(c,'GUIDE','alice',['alice','alice-laptop']),members:r.buildMemberHelp(c,'alice',['- alice: devices alice-laptop (online)']),status:r.buildStatusHelp(c,['- alice: devices alice-laptop (online)'])},
 guide:r.buildGuideRules(c),
 };
}
