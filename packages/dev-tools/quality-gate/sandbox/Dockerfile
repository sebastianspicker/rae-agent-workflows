# Build from the repository root with locked dependencies and compiled TypeScript exports.
FROM node:26.12.0-bookworm-slim@sha256:742a0fe7320e09e0321222b68165e6ac731d30470e7ea7f98f9bfc3a6e1034fe AS build
WORKDIR /opt/rae
COPY . .
RUN ["npm", "ci", "--ignore-scripts"]
RUN ["npm", "run", "build", "--workspace", "@rae/contracts"]
RUN ["npm", "run", "build", "--workspace", "@rae/dev-tools-shared"]
RUN ["npm", "run", "build", "--workspace", "packages/dev-tools/quality-gate"]
RUN ["npm", "prune", "--omit=dev", "--ignore-scripts"]

FROM node:26.12.0-bookworm-slim@sha256:742a0fe7320e09e0321222b68165e6ac731d30470e7ea7f98f9bfc3a6e1034fe
WORKDIR /opt/rae/packages/dev-tools/quality-gate
COPY --from=build /opt/rae/node_modules/ /opt/rae/node_modules/
COPY --from=build /opt/rae/packages/dev-tools/shared/dist/ /opt/rae/packages/dev-tools/shared/dist/
COPY --from=build /opt/rae/packages/dev-tools/shared/package.json /opt/rae/packages/dev-tools/shared/package.json
COPY --from=build /opt/rae/packages/dev-tools/quality-gate/dist/ dist/
COPY --from=build /opt/rae/packages/dev-tools/quality-gate/package.json ./
COPY --from=build /opt/rae/packages/contracts/ /opt/rae/packages/contracts/
# The tool lives in /opt/rae so the read-only repository mount at /workspace cannot hide it.
ENV RAE_TOOL_ROOT=/opt/rae
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD ["node", "dist/index.js", "--healthcheck"]
ENTRYPOINT ["node", "dist/index.js"]
