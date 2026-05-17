const axios = require('axios');

axios.post('https://users.roblox.com/v1/usernames/users', 
    { usernames: ['Roblox'], excludeBannedUsers: false },
    { headers: { 'Content-Type': 'application/json' } }
).then(r => console.log(JSON.stringify(r.data)))
.catch(e => console.error('ERROR:', e.message, e?.response?.status, JSON.stringify(e?.response?.data)));