export function requireBody(req, res, next){
    if(!req || !req.body){
        return res.status(400).send({
            message: 'no header found'
        })
    }
    next();
}