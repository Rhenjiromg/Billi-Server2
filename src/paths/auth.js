const express = require('express')
const router = express.Router()

router.get('/',(req, res) => {
    res.status(200).send({
        message: 'this path is ok'
    })
})

router.post('/login', async(req, res) => {
    if(!req || !req.body){
        return res.status(400).message({
            message: 'no request given'
        })
    }
    const {password, email, username} = req.body;

    if(!email && !username){
        return res.status(400).send({
            message: 'no login credentials given'
        })
    }

    if(!password){
        return res.status(400).send({
            message: 'no password given'
        })
    }

    let apiRes;
    if(!email){
        //treat as a username login
        apiRes = await loginEmail();
    }else{
        //treat as an email login
        apiRes = await loginUsername();
    }

    if(apiRes.token) {
        return res.status(200).send({
            token: apiRes.token, 
            expired: apiRes.expired
        })
    }
    else{
        return res.status(404).send({
            token: null, 
            expired: null,
            message: 'login failed, please try again'
        })
    }
})

const loginEmail = async() => {}
const loginUsername = async() => {}

router.post('/refresh', async(req, res) => {
    if(!req || !req.body){
        return res.status(400).send({
            message: 'no refresh tokens were given'
        })
    }

    try{

    }catch(error){
        console.error(error);
        return res.status(500).send({
            message: error.message
        })
    }
})

module.exports = router