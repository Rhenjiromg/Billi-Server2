const express = require('express');
const app = express()

app.use(express.json());
app.get('/', (req, res) => {
    const time = new Date();
})
app.listen('3000', () => {
    console.log('server is online')
})