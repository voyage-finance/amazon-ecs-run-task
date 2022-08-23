import core from '@actions/core';
import aws from 'aws-sdk';
import {
  Container,
  RegisterTaskDefinitionRequest,
  TaskDefinition,
} from 'aws-sdk/clients/ecs';
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';

const MAX_WAIT_MINUTES = 360; // 6 hours
const WAIT_DEFAULT_DELAY_SEC = 15;

// Attributes that are returned by DescribeTaskDefinition, but are not valid RegisterTaskDefinition inputs
const IGNORED_TASK_DEFINITION_ATTRIBUTES = [
  'compatibilities',
  'taskDefinitionArn',
  'requiresAttributes',
  'revision',
  'status',
  'registeredAt',
  'deregisteredAt',
  'registeredBy',
];

type TaskDef = Record<string, unknown>;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    interface ProcessEnv {
      GITHUB_WORKSPACE: string;
    }
  }
}

function isEmptyValue(value: unknown) {
  if (value === null || value === undefined || value === '') {
    return true;
  }

  if (Array.isArray(value)) {
    for (const element of value) {
      if (!isEmptyValue(element)) {
        // the array has at least one non-empty element
        return false;
      }
    }
    // the array has no non-empty elements
    return true;
  }

  if (typeof value === 'object') {
    for (const childValue of Object.values(value)) {
      if (!isEmptyValue(childValue)) {
        // the object has at least one non-empty property
        return false;
      }
    }
    // the object has no non-empty property
    return true;
  }

  return false;
}

function emptyValueReplacer(_: unknown, value: unknown) {
  if (isEmptyValue(value)) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.filter((e) => !isEmptyValue(e));
  }

  return value;
}

function cleanNullKeys(obj: unknown) {
  return JSON.parse(JSON.stringify(obj, emptyValueReplacer));
}

function removeIgnoredAttributes(taskDef: TaskDef) {
  for (const attribute of IGNORED_TASK_DEFINITION_ATTRIBUTES) {
    if (taskDef[attribute]) {
      core.warning(
        `Ignoring property '${attribute}' in the task definition file. ` +
          'This property is returned by the Amazon ECS DescribeTaskDefinition API and may be shown in the ECS console, ' +
          'but it is not a valid field when registering a new task definition. ' +
          'This field can be safely removed from your task definition file.',
      );
      delete taskDef[attribute];
    }
  }

  return taskDef;
}

function maintainValidObjects(taskDef: TaskDefinition) {
  if (validateProxyConfigurations(taskDef)) {
    taskDef.proxyConfiguration?.properties?.forEach((property, index, arr) => {
      if (!('value' in property)) {
        arr[index].value = '';
      }
      if (!('name' in property)) {
        arr[index].name = '';
      }
    });
  }

  if (taskDef && taskDef.containerDefinitions) {
    taskDef.containerDefinitions.forEach((container) => {
      if (container.environment) {
        container.environment.forEach((property, index, arr) => {
          if (!('value' in property)) {
            arr[index].value = '';
          }
        });
      }
    });
  }
  return taskDef;
}

function validateProxyConfigurations(taskDef: TaskDefinition) {
  return (
    !!taskDef.proxyConfiguration &&
    taskDef.proxyConfiguration.type &&
    taskDef.proxyConfiguration.type == 'APPMESH' &&
    taskDef.proxyConfiguration.properties &&
    taskDef.proxyConfiguration.properties.length > 0
  );
}

async function waitForTasksStopped(
  ecs: aws.ECS,
  clusterName: string,
  taskArns: string[],
  waitForMinutes: number,
) {
  if (waitForMinutes > MAX_WAIT_MINUTES) {
    waitForMinutes = MAX_WAIT_MINUTES;
  }

  const maxAttempts = (waitForMinutes * 60) / WAIT_DEFAULT_DELAY_SEC;

  core.debug('Waiting for tasks to stop');

  const waitTaskResponse = await ecs
    .waitFor('tasksStopped', {
      cluster: clusterName,
      tasks: taskArns,
      $waiter: {
        delay: WAIT_DEFAULT_DELAY_SEC,
        maxAttempts: maxAttempts,
      },
    })
    .promise();

  core.debug(`Run task response ${JSON.stringify(waitTaskResponse)}`);

  core.info(
    `All tasks have stopped. Watch progress in the Amazon ECS console: https://console.aws.amazon.com/ecs/home?region=${aws.config.region}#/clusters/${clusterName}/tasks`,
  );
}

async function tasksExitCode(
  ecs: aws.ECS,
  clusterName: string,
  taskArns: string[],
) {
  const describeResponse = await ecs
    .describeTasks({
      cluster: clusterName,
      tasks: taskArns,
    })
    .promise();

  const containers: Container[] = [];
  describeResponse.tasks?.forEach((task) => {
    if (task.containers) containers.push(...task.containers);
  });
  const exitCodes = containers.map((container) => container.exitCode);
  const reasons = containers.map((container) => container.reason);

  const failuresIdx: number[] = [];

  exitCodes.filter((exitCode, index) => {
    if (exitCode !== 0) {
      failuresIdx.push(index);
    }
  });

  const failures = reasons.filter(
    (_, index) => failuresIdx.indexOf(index) !== -1,
  );

  if (failures.length > 0) {
    core.setFailed(failures.join('\n'));
  } else {
    core.info(`All tasks have exited successfully.`);
  }
}

async function runTask(
  ecs: aws.ECS,
  cluster: string,
  taskDefArn: string,
  count: number,
  startedBy: string,
  waitForFinish: string,
  waitForMinutes: number,
) {
  core.debug('Running task');
  const runTaskResponse = await ecs
    .runTask({
      cluster,
      taskDefinition: taskDefArn,
      startedBy,
      count,
    })
    .promise();

  core.debug(`Run task response: ${JSON.stringify(runTaskResponse, null, 4)}`);
  if (runTaskResponse.failures && runTaskResponse.failures.length > 0) {
    const [failure] = runTaskResponse.failures;
    throw new Error(`${failure.arn} failed: ${failure.reason}`);
  }

  const taskArns: string[] = [];

  runTaskResponse.tasks?.forEach((task) => {
    if (task.taskArn) taskArns.push(task.taskArn);
  });
  core.setOutput('task-arn', taskArns);

  const consoleHostname = aws.config?.region?.startsWith('cn')
    ? 'console.amazonaws.cn'
    : 'console.aws.amazon.com';
  core.info(
    `Task(s) started. Watch progress in the Amazon ECS console: https://${consoleHostname}/ecs/home?region=${aws.config.region}#/clusters/${cluster}/tasks`,
  );

  if (waitForFinish?.toLowerCase() === 'true') {
    await waitForTasksStopped(ecs, cluster, taskArns, waitForMinutes);
    await tasksExitCode(ecs, cluster, taskArns);
  }
}

async function run() {
  try {
    const ecs = new aws.ECS({
      customUserAgent: 'amazon-ecs-deploy-task-definition-for-github-actions',
    });
    // Get inputs
    const taskDefinitionFile = core.getInput('task-definition', {
      required: true,
    });
    const cluster = core.getInput('cluster', { required: true });
    const count = parseInt(core.getInput('count', { required: true }));
    const startedBy =
      core.getInput('started-by', { required: false }) ||
      'amazon-ecs-run-task-for-github-actions';
    const waitForFinish = core.getInput('wait-for-finish', { required: false });
    let waitForMinutes =
      parseInt(core.getInput('wait-for-minutes', { required: false })) || 30;
    if (waitForMinutes > MAX_WAIT_MINUTES) {
      waitForMinutes = MAX_WAIT_MINUTES;
    }

    // Register the task definition
    core.debug('Registering the task definition');
    const taskDefPath = path.isAbsolute(taskDefinitionFile)
      ? taskDefinitionFile
      : path.join(process.env.GITHUB_WORKSPACE, taskDefinitionFile);
    const fileContents = fs.readFileSync(taskDefPath, 'utf8');
    const taskDefContents = maintainValidObjects(
      removeIgnoredAttributes(cleanNullKeys(yaml.parse(fileContents))),
    );
    let registerResponse;
    try {
      registerResponse = await ecs
        .registerTaskDefinition(
          taskDefContents as RegisterTaskDefinitionRequest,
        )
        .promise();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      core.setFailed(
        'Failed to register task definition in ECS: ' + error.message,
      );
      core.debug('Task definition contents:');
      core.debug(JSON.stringify(taskDefContents, undefined, 4));
      throw error;
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const taskDefArn = registerResponse.taskDefinition!.taskDefinitionArn!;
    core.setOutput('task-definition-arn', taskDefArn);

    core.debug(
      `Running task with ${JSON.stringify({
        cluster,
        taskDefArn,
        count,
      })}`,
    );

    await runTask(
      ecs,
      cluster,
      taskDefArn,
      count,
      startedBy,
      waitForFinish,
      waitForMinutes,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    core.setFailed(error.message);
    core.debug(error.stack);
  }
}

export default run;
