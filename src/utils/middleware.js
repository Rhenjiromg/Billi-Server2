export function requireBody(req, res, next){
    if(!req.body && !req.files){
        return res.status(400).send({
            message: 'no body was found'
        })
    }
    next();
}