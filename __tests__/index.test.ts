import run from '../src';
import * as core from '@actions/core';
import fs from 'fs';
import path from 'path';

const mockEcsRegisterTaskDef = jest.fn(() => {
  return {
    promise() {
      return Promise.resolve({
        taskDefinition: { taskDefinitionArn: 'task:def:arn' },
      });
    },
  };
});
const mockEcsDescribeTasks = jest.fn(() => {
  return {
    promise() {
      return Promise.resolve({
        failures: [],
        tasks: [
          {
            containers: [
              {
                lastStatus: 'RUNNING',
                exitCode: 0,
                reason: '',
                taskArn: 'arn:aws:ecs:fake-region:account_id:task/arn',
              },
            ],
            desiredStatus: 'RUNNING',
            lastStatus: 'RUNNING',
            taskArn: 'arn:aws:ecs:fake-region:account_id:task/arn',
          },
        ],
      });
    },
  };
});
const mockRunTasks = jest.fn(() => {
  return {
    promise() {
      return Promise.resolve({
        failures: [],
        tasks: [
          {
            containers: [
              {
                lastStatus: 'RUNNING',
                exitCode: 0,
                reason: '',
                taskArn: 'arn:aws:ecs:fake-region:account_id:task/arn',
              },
            ],
            desiredStatus: 'RUNNING',
            lastStatus: 'RUNNING',
            taskArn: 'arn:aws:ecs:fake-region:account_id:task/arn',
            // taskDefinitionArn: "arn:aws:ecs:<region>:<aws_account_id>:task-definition/amazon-ecs-sample:1"
          },
        ],
      });
    },
  };
});
const mockEcsWaiter = jest.fn(() => {
  return {
    promise() {
      return Promise.resolve({});
    },
  };
});

jest.mock('aws-sdk', () => {
  return {
    config: {
      region: 'fake-region',
    },
    ECS: jest.fn(() => ({
      registerTaskDefinition: mockEcsRegisterTaskDef,
      describeTasks: mockEcsDescribeTasks,
      runTask: mockRunTasks,
      waitFor: mockEcsWaiter,
    })),
  };
});

jest.mock('@actions/core', () => {
  const mockedActions = jest.createMockFromModule<typeof core>('@actions/core');
  return {
    __esModule: true,
    ...mockedActions,
    getInput: jest.fn(),
  };
});

jest.mock('fs', () => ({
  readFileSync: (pathInput: string, encoding: string) => {
    if (encoding != 'utf8') {
      throw new Error(`Wrong encoding ${encoding}`);
    }

    console.log('path input: ', pathInput);

    if (
      pathInput ==
      path.join(process.env.GITHUB_WORKSPACE, 'task-definition.json')
    ) {
      return JSON.stringify({ family: 'task-def-family' });
    }

    throw new Error(`Unknown path ${pathInput}`);
  },
  promises: {
    access: jest.fn(),
  },
}));

const networkConfiguration = {
  awsvpcConfiguration: {
    subnets: ['subnet-0006a81c3fb6df455', 'subnet-03b288826d0463c1d'],
    securityGroups: ['sg-0706a4351efc1eb0c'],
    assignPublicIp: 'ENABLED',
  },
};
describe('Deploy to ECS', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .mocked(core.getInput)
      .mockReturnValueOnce('task-definition.json') // task-definition
      .mockReturnValueOnce('cluster-789') // cluster
      .mockReturnValueOnce('1') // count
      .mockReturnValueOnce(JSON.stringify(networkConfiguration))
      .mockReturnValueOnce('amazon-ecs-run-task-for-github-actions'), // started-by
      (process.env = Object.assign(process.env, {
        GITHUB_WORKSPACE: __dirname,
      }));
    mockEcsWaiter.mockImplementation(() => {
      return {
        promise() {
          return Promise.resolve({});
        },
      };
    });
  });

  test('registers the task definition contents and runs the task', async () => {
    await run();
    expect(core.setFailed).toHaveBeenCalledTimes(0);
    expect(mockEcsRegisterTaskDef).toHaveBeenNthCalledWith(1, {
      family: 'task-def-family',
    });
    expect(core.setOutput).toHaveBeenNthCalledWith(
      1,
      'task-definition-arn',
      'task:def:arn',
    );
    expect(mockRunTasks).toHaveBeenNthCalledWith(1, {
      cluster: 'cluster-789',
      taskDefinition: 'task:def:arn',
      networkConfiguration,
      count: 1,
      startedBy: 'amazon-ecs-run-task-for-github-actions',
    });
    expect(mockEcsWaiter).toHaveBeenCalledTimes(0);
    expect(core.setOutput).toBeCalledWith('task-arn', [
      'arn:aws:ecs:fake-region:account_id:task/arn',
    ]);
  });

  test('registers the task definition contents and waits for tasks to finish successfully', async () => {
    jest
      .mocked(core.getInput)
      .mockReset()
      .mockReturnValueOnce('task-definition.json') // task-definition
      .mockReturnValueOnce('cluster-789') // cluster
      .mockReturnValueOnce('1') // count
      .mockReturnValueOnce(JSON.stringify(networkConfiguration))
      .mockReturnValueOnce('amazon-ecs-run-task-for-github-actions') // started-by
      .mockReturnValueOnce('true');
    await run();
    expect(core.setFailed).toHaveBeenCalledTimes(0);

    expect(mockEcsRegisterTaskDef).toHaveBeenNthCalledWith(1, {
      family: 'task-def-family',
    });
    expect(core.setOutput).toHaveBeenNthCalledWith(
      1,
      'task-definition-arn',
      'task:def:arn',
    );
    expect(mockEcsDescribeTasks).toHaveBeenNthCalledWith(1, {
      cluster: 'cluster-789',
      tasks: ['arn:aws:ecs:fake-region:account_id:task/arn'],
    });

    expect(mockEcsWaiter).toHaveBeenCalledTimes(1);

    expect(core.info).toBeCalledWith('All tasks have exited successfully.');
  });

  test('cleans null keys out of the task definition contents', async () => {
    fs.readFileSync = jest.fn((pathInput, encoding) => {
      if (encoding != 'utf8') {
        throw new Error(`Wrong encoding ${encoding}`);
      }

      return '{ "ipcMode": null, "family": "task-def-family" }' as any;
    });

    await run();
    expect(core.setFailed).toHaveBeenCalledTimes(0);
    expect(mockEcsRegisterTaskDef).toHaveBeenNthCalledWith(1, {
      family: 'task-def-family',
    });
  });

  test('cleans empty arrays out of the task definition contents', async () => {
    jest.mocked(fs).readFileSync.mockImplementation((pathInput, encoding) => {
      if (encoding != 'utf8') {
        throw new Error(`Wrong encoding ${encoding}`);
      }

      return '{ "tags": [], "family": "task-def-family" }';
    });

    await run();
    expect(core.setFailed).toHaveBeenCalledTimes(0);
    expect(mockEcsRegisterTaskDef).toHaveBeenNthCalledWith(1, {
      family: 'task-def-family',
    });
  });

  test('cleans empty strings and objects out of the task definition contents', async () => {
    jest.mocked(fs).readFileSync.mockImplementation((pathInput, encoding) => {
      if (encoding != 'utf8') {
        throw new Error(`Wrong encoding ${encoding}`);
      }

      return `
            {
                "memory": "",
                "containerDefinitions": [ {
                    "name": "sample-container",
                    "logConfiguration": {},
                    "repositoryCredentials": { "credentialsParameter": "" },
                    "command": [
                        ""
                    ],
                    "environment": [
                        {
                            "name": "hello",
                            "value": "world"
                        },
                        {
                            "name": "",
                            "value": ""
                        }
                    ],
                    "secretOptions": [ {
                        "name": "",
                        "valueFrom": ""
                    } ],
                    "cpu": 0,
                    "essential": false
                } ],
                "requiresCompatibilities": [ "EC2" ],
                "family": "task-def-family"
            }
            `;
    });

    await run();
    expect(core.setFailed).toHaveBeenCalledTimes(0);
    expect(mockEcsRegisterTaskDef).toHaveBeenNthCalledWith(1, {
      family: 'task-def-family',
      containerDefinitions: [
        {
          name: 'sample-container',
          cpu: 0,
          essential: false,
          environment: [
            {
              name: 'hello',
              value: 'world',
            },
          ],
        },
      ],
      requiresCompatibilities: ['EC2'],
    });
  });

  test('cleans invalid keys out of the task definition contents', async () => {
    jest.mocked(fs).readFileSync.mockImplementation((pathInput, encoding) => {
      if (encoding != 'utf8') {
        throw new Error(`Wrong encoding ${encoding}`);
      }

      return '{ "compatibilities": ["EC2"], "taskDefinitionArn": "arn:aws...:task-def-family:1", "family": "task-def-family", "revision": 1, "status": "ACTIVE" }';
    });

    await run();
    expect(core.setFailed).toHaveBeenCalledTimes(0);
    expect(mockEcsRegisterTaskDef).toHaveBeenNthCalledWith(1, {
      family: 'task-def-family',
    });
  });

  test('error is caught if task def registration fails', async () => {
    mockEcsRegisterTaskDef.mockImplementation(() => {
      throw new Error('Could not parse');
    });

    await run();

    expect(core.setFailed).toHaveBeenCalledTimes(2);
    expect(core.setFailed).toHaveBeenNthCalledWith(
      1,
      'Failed to register task definition in ECS: Could not parse',
    );
    expect(core.setFailed).toHaveBeenNthCalledWith(2, 'Could not parse');
  });
});
