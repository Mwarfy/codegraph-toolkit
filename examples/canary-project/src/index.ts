// Entry point — imports good code only. Should NOT be flagged orphan
// (it's the convention root). Imports the hub so it shows up.
import { hub } from './bad/hub.js'
import { greet } from './good/greet.js'
import { compute } from './bad/cycle-a.js'
import { veryLongFunction } from './bad/long-function.js'
import { transition } from './bad/fsm.js'
import { processItems } from './bad/magic-await.js'
import { dangerouslyExec } from './bad/taint.js'
import { hashPassword, generateToken } from './bad/crypto-weak.js'
import { SCOPES_USED } from './bad/oauth-scope.js'
import { publishOrder, subscribe } from './bad/events.js'
import { processOrder } from './bad/duplicate-a.js'
import { processInvoice } from './bad/duplicate-b.js'
import { getApiUrl, EMAIL_RE, api_key, setEnabled, silentFail, oldApi, HOUR_IN_SEC, fireAndForget } from './bad/extras.js'
import { recordEvent, fetchRecentEvents } from './bad/truth-point.js'

export function main(): string {
  return [
    greet('world'),
    hub(),
    compute(3),
    String(veryLongFunction(2)),
    transition('pending', 'start'),
    String(processOrder([1, 2, 3], 0.1)),
    String(processInvoice([1, 2, 3], 0.1)),
    hashPassword('hello'),
    generateToken(),
    SCOPES_USED.join(','),
  ].join(' / ')
}

// Used pour silencer noise tooling — ne change pas la vérité du fixture
void processItems
void dangerouslyExec
void publishOrder
void subscribe
void getApiUrl
void EMAIL_RE
void api_key
void setEnabled
void silentFail
void oldApi
void HOUR_IN_SEC
void fireAndForget
void recordEvent
void fetchRecentEvents
