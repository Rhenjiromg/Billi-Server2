const express = require('express');
const authPath = require('./src/paths/auth');
const app = express()

/**
 *  Use functions
 */
app.use(express.json());
app.use('/auth', authPath);

app.get('/', (req, res) => {
    const time = new Date();
    return res.status(200).send('request received at', time)
})

const port = process.env.PORT ?? '8080'
app.listen( port , () => {
    console.log('server is online')
})