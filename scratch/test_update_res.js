const url = 'https://zrumnqtgdscrwgcguseq.supabase.co/rest/v1';
const apikey = 'sb_publishable_xEqE6S21QUMCkDxSMvTskg_9g3pi-vZ';
fetch(`${url}/research_requests?id=eq.4e8fbe0e-3cba-4211-8281-1bcb0e286f98`, {
  method: 'PATCH',
  headers: {
    'apikey': apikey,
    'Authorization': `Bearer ${apikey}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  },
  body: JSON.stringify({ status: 'in_progress' })
}).then(r => r.text().then(t => console.log(r.status, t)));
