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

    let res;
    if(!email){
        //treat as a username login
        res = await loginEmail();
    }else{
        //treat as an email login
        res = await loginUsername();
    }

    if(res.token) {
        return res.status(200).send({
            token: res.token, 
            expired: res.expired
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

module.exports = router