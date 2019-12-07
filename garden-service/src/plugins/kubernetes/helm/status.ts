/*
 * Copyright (C) 2018 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { ServiceStatus, ServiceState, ForwardablePort } from "../../../types/service"
import { GetServiceStatusParams } from "../../../types/plugin/service/getServiceStatus"
import { LogEntry } from "../../../logger/log-entry"
import { helm } from "./helm-cli"
import { HelmModule } from "./config"
import { getReleaseName } from "./common"
import { KubernetesPluginContext } from "../config"
import { getForwardablePorts } from "../port-forward"
import { KubernetesServerResource } from "../types"
import { safeLoadAll } from "js-yaml"

const helmStatusMap: { [status: string]: ServiceState } = {
  unknown: "unknown",
  deployed: "ready",
  deleted: "missing",
  superseded: "stopped",
  failed: "unhealthy",
  deleting: "stopped",
}

interface HelmStatusDetail {
  remoteResources?: KubernetesServerResource[]
}

export type HelmServiceStatus = ServiceStatus<HelmStatusDetail>

export async function getServiceStatus({
  ctx,
  module,
  log,
  hotReload,
}: GetServiceStatusParams<HelmModule>): Promise<HelmServiceStatus> {
  const k8sCtx = <KubernetesPluginContext>ctx
  const releaseName = getReleaseName(module)

  const detail: HelmStatusDetail = {}
  let state: ServiceState

  try {
    const helmStatus = await getReleaseStatus(k8sCtx, module, releaseName, log, hotReload)
    state = helmStatus.state
  } catch (err) {
    state = "missing"
  }

  let forwardablePorts: ForwardablePort[] = []

  if (state !== "missing") {
    const deployedResources = await getDeployedResources(k8sCtx, releaseName, log)
    forwardablePorts = getForwardablePorts(deployedResources)
  }

  return {
    forwardablePorts,
    state,
    version: state === "ready" ? module.version.versionString : undefined,
    detail,
  }
}

export async function getDeployedResources(ctx: KubernetesPluginContext, releaseName: string, log: LogEntry) {
  return safeLoadAll(
    await helm({
      ctx,
      log,
      args: ["get", "manifest", releaseName],
    })
  )
}

export async function getReleaseStatus(
  ctx: KubernetesPluginContext,
  module: HelmModule,
  releaseName: string,
  log: LogEntry,
  hotReload: boolean
): Promise<ServiceStatus> {
  try {
    log.silly(`Getting the release status for ${releaseName}`)
    const res = JSON.parse(await helm({ ctx, log, args: ["status", releaseName, "--output", "json"] }))

    let state = helmStatusMap[res.info.status] || "unknown"

    if (state === "ready") {
      // Make sure the right version is deployed
      const deployedValues = JSON.parse(
        await helm({
          ctx,
          log,
          args: ["get", "values", releaseName, "--output", "json"],
        })
      )
      const deployedVersion = deployedValues[".garden"] && deployedValues[".garden"].version
      const hotReloadEnabled = deployedValues[".garden"] && deployedValues[".garden"].hotReload === true

      if ((hotReload && !hotReloadEnabled) || !deployedVersion || deployedVersion !== module.version.versionString) {
        state = "outdated"
      }
    }

    return {
      state,
      detail: res,
    }
  } catch (err) {
    if (err.message.includes("release: not found")) {
      return { state: "missing", detail: {} }
    } else {
      throw err
    }
  }
}
