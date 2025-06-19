const axios = require('axios');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const flowiseUrl = 'http://localhost:3000/api/v1/prediction/cee111b6-eaf0-4b47-a6cb-4cdf77ec59da';

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
