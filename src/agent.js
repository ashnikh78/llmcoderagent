const axios = require('axios');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const flowiseUrl = 'http://localhost:3000/api/v1/prediction/ccbfcde1-d3f3-40b2-9436-c3ba6b8a95a2';

rl.question('Ask your agent: ', async (question) => {
  try {
    const response = await axios.post(flowiseUrl, {
      question: question
    });
    console.log('\nAgent says:', response.data);
  } catch (err) {
    console.error('Error:', err.message);
  }
  rl.close();
});
