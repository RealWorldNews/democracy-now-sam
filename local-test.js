require('dotenv').config(); // Load environment variables
const { handler } = require('./index'); // Adjust the path to your Lambda function file

(async () => {
  // Simulate the event object that would be passed to the Lambda function
  const event = {
    url: 'https://www.democracynow.org/headlines' // Example URL for Democracy Now! headlines
  };

  const context = {}; // Mock context object if needed

  try {
    // Call the Lambda handler function
    const result = await handler(event, context);
    console.log('Lambda function result:', result);
  } catch (error) {
    console.error('Error running the Lambda function locally:', error);
  }
})();
