const express = require('express');
const authPath = require('./src/paths/auth');
const receiptPath = require('./src/paths/receipts')
const app = express()
const dotenv = require('dotenv');

dotenv.config();

/**
 *  Use functions
 */
app.use(express.json());
app.use('/auth', authPath);
app.use('/receipt', receiptPath);

app.get('/', (req, res) => {
    const time = new Date();
    return res.status(200).send({message:  `request received at ${time}`})
})

const port = process.env.PORT ?? '8080'
app.listen( port , () => {
    console.log('server is online')
})