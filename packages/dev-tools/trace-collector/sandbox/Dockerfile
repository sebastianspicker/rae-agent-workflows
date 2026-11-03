# Build from the repository root with locked dependencies and compiled TypeScript exports.
FROM node:26.13.0-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9 AS build
WORKDIR /opt/rae
COPY . .
RUN ["npm", "ci", "--ignore-scripts"]
RUN ["npm", "run", "build", "--workspace", "@rae/contracts"]
RUN ["npm", "run", "build", "--workspace", "@rae/dev-tools-shared"]
RUN ["npm", "run", "build", "--workspace", "packages/dev-tools/trace-collector"]
RUN ["npm", "prune", "--omit=dev", "--ignore-scripts"]

FROM node:26.13.0-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9
WORKDIR /opt/rae/packages/dev-tools/trace-collector
COPY --from=build /opt/rae/node_modules/ /opt/rae/node_modules/
COPY --from=build /opt/rae/packages/dev-tools/shared/dist/ /opt/rae/packages/dev-tools/shared/dist/
COPY --from=build /opt/rae/packages/dev-tools/shared/package.json /opt/rae/packages/dev-tools/shared/package.json
COPY --from=build /opt/rae/packages/dev-tools/trace-collector/dist/ dist/
COPY --from=build /opt/rae/packages/dev-tools/trace-collector/package.json ./
COPY --from=build /opt/rae/packages/contracts/ /opt/rae/packages/contracts/
# The tool lives in /opt/rae so the read-only repository mount at /workspace cannot hide it.
ENV RAE_TOOL_ROOT=/opt/rae
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD ["node", "dist/index.js", "--healthcheck"]
ENTRYPOINT ["node", "dist/index.js"]
