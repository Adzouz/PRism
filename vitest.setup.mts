const inheritedGit =
  /^GIT_(CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)|DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|PREFIX)$/

for (const key of Object.keys(process.env)) {
  if (inheritedGit.test(key)) delete process.env[key]
}
