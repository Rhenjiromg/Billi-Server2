import jwt from 'jsonwebtoken';
import * as dotenv from 'dotenv';

dotenv.config()

const secret = process.env.SECRET ?? '';
const issuer = process.env.ISSUER ?? '';
const client = process.env.CLIENT ?? '';

export function authenticate(req, res, next){
    const header = req.headers.authorization;
    if(!header){
        return res.status(400).send({
            message: 'no header found'
        })
    }
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if(!token){
        return res.status(401).send({
            message: 'no token was found'
        })
    }
    try{
        const payload = jwt.verify(token, secret, {
            issuer,
            client,
        })
    }catch(error){
        console.error(error);
        return res.status(403).send({
            message: 'token is invalid'
        })
    }

    next();
}
