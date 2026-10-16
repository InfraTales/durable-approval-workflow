import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';

/** Create the same key schema the stack creates, in DynamoDB Local. */
export async function createTable(tableName: string): Promise<DynamoDBClient> {
  const client = new DynamoDBClient({});
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      AttributeDefinitions: [{ AttributeName: 'requestId', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'requestId', KeyType: 'HASH' }],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  );
  return client;
}

export async function deleteTable(client: DynamoDBClient, tableName: string): Promise<void> {
  await client.send(new DeleteTableCommand({ TableName: tableName }));
  client.destroy();
}
