const express = require('express')
const router = express.Router()
const firebase = require('../utils/firebase')
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Filter } = require('firebase-admin/firestore');
const crypto = require('node:crypto');
const { authenticate } = require('../utils/authMiddleware');

const dotenv = require('dotenv').config();

const db = firebase.db;
const storage = firebase.storage;
const secret = process.env.SECRET ?? '';
const issuer = process.env.ISSUER ?? '';
const client = process.env.CLIENT ?? '';

router.use(express.json());

const checkValidity = async(username, email) => {
    const snap = await db.collection('users').where(Filter.or(
        Filter.where('username', '==', username),
        Filter.where('email', '==', email)
    )).limit(1).get()
    return snap.empty;
}

const generateToken = (userid) => {
    console.log(userid);
    const payLoad = {
        userid
    }
    return jwt.sign(payLoad, secret, {
    expiresIn: "90d",          
    issuer: issuer,
    audience: client,
    algorithm: "HS256",        
  });
}

const generateRefreshToken = () => {
    return crypto.randomBytes(32).toString("base64url")
}

const assignAuthStatus = async(token, refreshToken, userId) => {
    await db.collection('auth').doc(refreshToken).set({
        refreshToken: refreshToken, 
        latestToken: token, 
        assignedTo: userId, 
        lastUpdate: new Date()
    })
}

const updateAuthStatus = async(token, refreshToken) => {
    await db.collection('auth').doc(refreshToken).update({
        token: token, 
        lastUpdate: new Date()
    })
}

const hashPassword = async(password) => {
    return await bcrypt.hash(password, 10);
}

const hashToken = async(token) => {
    return await bcrypt.hash(token, 10);
}

router.post('/create-account', async(req, res) => {
    try{
        if(!req || !req.body){
            return res.status(400).send({
                message: 'no body was found!'
            })
        }
        const {
            username, email, password, name, phoneNumber
        } = req.body;

        if(!username || !email || !password || !name || !phoneNumber || password.length < 8) {
            return res.status(400).send({
                message: 'incomplete form!'
            })
        }

        const hashedPassword = await hashPassword(password)

        const newUser = {
            username, email, name, phoneNumber,
            password: hashedPassword,
            createdAt: new Date(), 
            isDeleted: false, 
            isActive: true, 
            friends: [], 
            receipts: [], 
            receiptCount: 0,
        }

        const valid = await checkValidity(username, email);

        if(!valid){
            return res.status(401).send({
                message: 'username/email taken, please try again'
            })
        }

        await db.collection('users').doc().set(newUser)

        return res.status(201).send({
            message: 'account created!'
        })
    }catch(error){
        console.error(error)
        return res.status(500).send({
            error: error
        })
    }
})

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

    console.log(password)

    if(email.length == 0 && username == 0){
        return res.status(400).send({
            message: 'no login credentials given'
        })
    }

    if(!password){
        return res.status(400).send({
            message: 'no password given'
        })
    }
    let snap;
    if(username.length > 0){
        snap = await db.collection('users').where('username', '==', username).limit(1).get();
    }else if (email.length > 0){
        snap = await db.collection('users').where('email', '==', email).limit(1).get();
    }

    if(!snap){
        return res.status(404).send({
            message: 'user is not found'
        })
    }
    const data = snap.docs[0].data()
    try{
        const compare = await bcrypt.compare(password, data.password);
        console.log(compare);
        if(compare){
            token = generateToken(snap.docs[0].id);
            const refreshToken = generateRefreshToken();
            await assignAuthStatus(token, refreshToken, snap.docs[0].id);
            return res.status(200).send({
                token: token,
                refreshToken: refreshToken,
                id: snap.docs[0].id,
            })
        }else{
            return res.status(404).send({
                message: 'invalid credentials'
            })
        }
    }catch(error){
        console.error(error);
        return res.status(500).send({
            error: error
        })
    }
})

router.post('/refresh', async(req, res) => {
    if(!req || !req.body){
        return res.status(400).send({
            message: 'no refresh tokens were given'
        })
    }

    const {refreshToken} = req.body;
    if(!refreshToken){
        return res.status(400).send({
            message: 'no refresh token was provided'
        })
    }

    try{
        const data = await db.collection('auth').doc(refreshToken).get()
        if(!data.exists){
            return res.status(404).send({
                message: 'refresh token not recognized'
            })
        }
        const newToken = generateToken(data.id);
        await updateAuthStatus(newToken, refreshToken);

        return res.status(200).send({
            token: newToken
        })
    }catch(error){
        console.error(error);
        return res.status(500).send({
            message: error.message
        })
    }
})

router.get('/protected', authenticate, async(req, res) => {
    return res.status(200).send({
        message: 'got it'
    })
})

router.post('/logout', authenticate, async(req, res) => {
    try{
        const {refreshToken} = req.body;
        if(!refreshToken){
            return res.status(400).send({
                message: 'no refresh token was given'
            })
        }

        const authInstance = await  db.collection("auth").doc(refreshToken).get();
        if(!authInstance){
            return res.status(404).send({
                message: 'session not found'
            })
        }
        else {
            await db.collection("auth").doc(refreshToken).delete();
            return res.status(200).send({
                message: 'logged out'
            });
        }
    }catch(error){
        console.error(error);
        return res.status(500).send({
            message: 'something went wrong logging you out'
        })
    }
})

module.exports = router