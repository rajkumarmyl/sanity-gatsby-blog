export default {
  widgets: [
    { name: 'structure-menu' },
    {
      name: 'project-info',
      options: {
        __experimental_before: [
          {
            name: 'netlify',
            options: {
              description:
                'NOTE: Because these sites are static builds, they need to be re-deployed to see the changes when documents are published.',
              sites: [
                {
                  buildHookId: '5f48046d1f73865adb87d2c5',
                  title: 'Sanity Studio',
                  name: 'sanity-gatsby-blog-studio-dd6dgbmq',
                  apiId: 'e1936403-baf9-464c-9da5-f59e2d5ff5e1'
                },
                {
                  buildHookId: '5f48046d7634d4009779d155',
                  title: 'Blog Website',
                  name: 'sanity-gatsby-blog-web-xsutdnec',
                  apiId: '80b8502e-bdc8-47e2-9dc5-65344856ef1a'
                }
              ]
            }
          }
        ],
        data: [
          {
            title: 'GitHub repo',
            value: 'https://github.com/rajkumarmyl/sanity-gatsby-blog',
            category: 'Code'
          },
          { title: 'Frontend', value: 'https://sanity-gatsby-blog-web-xsutdnec.netlify.app', category: 'apps' }
        ]
      }
    },
    { name: 'project-users', layout: { height: 'auto' } },
    {
      name: 'document-list',
      options: { title: 'Recent blog posts', order: '_createdAt desc', types: ['post'] },
      layout: { width: 'medium' }
    }
  ]
}
