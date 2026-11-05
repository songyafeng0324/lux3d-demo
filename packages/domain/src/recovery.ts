export const DEFAULT_DELIVERY_WINDOW_MS=24*60*60*1000;
type RecoveryInput={localStatus:string;providerTaskId?:string;providerStatus?:number;deliveryVerified:boolean;deadlineAt:number;now:number};
// For attempts already dispatched. Initial dispatch authorization is a separate
// operation. A recovery decision never authorizes another paid create call.
export function recoveryDecision(input:RecoveryInput){
 if(!Number.isFinite(input.deadlineAt)||!Number.isFinite(input.now))throw new Error('Invalid recovery clock');
 const providerTerminal=[3,4,6].includes(input.providerStatus??-1);
 const retainProviderReservation=!providerTerminal;
 const result=(action:string)=>({action,mayCreate:false,retainProviderReservation});
 if(input.localStatus==='succeeded'||input.localStatus==='failed')return result('preserve_terminal');
 // A completed, usable delivery wins a deadline race while the task is still
 // unfinalized. A previously committed failure remains protected above.
 if(input.providerStatus===3&&input.deliveryVerified)return result('finalize_success_once');
 if(input.providerStatus===4||input.providerStatus===6)return result('finalize_failure_once');
 if(input.now>=input.deadlineAt)return result('finalize_failure_once');
 if(input.providerStatus===3)return result('ingest_original');
 return result(input.providerTaskId?'query_original':'quarantine_and_reconcile');
}
