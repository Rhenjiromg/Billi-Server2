const express = require('express');
const authPath = require('./src/paths/auth');
const receiptPath = require('./src/paths/receipts')
const app = express()
const dotenv = require('dotenv');
const cors = require('cors');

dotenv.config();

app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  const expose = err.expose ?? (status >= 400 && status < 500); // expose 4xx messages by default
  return res.status(status).json({
    message: expose ? (err.message || 'Bad Request') : 'Internal Server Error'
  });
});

app.use(
  cors({
    origin: 'http://localhost:3000',
    credentials: true, // Access-Control-Allow-Credentials: true
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

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

const port = process.env.PORT ?? 8080
app.listen(port, "0.0.0.0", () => console.log(`up on ${port}`));