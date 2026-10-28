import { getPrintavoClient } from "../src/lib/printavoGateway";
const client = getPrintavoClient();
const schema: any = await client.query(`query {
 __schema { mutationType { fields { name args { name type { kind name ofType { kind name ofType {kind name} } } } type { kind name ofType {kind name} } } } }
 invoiceType: __type(name:"Invoice") { fields {name type {kind name ofType {kind name}}} }
 invoiceInput: __type(name:"InvoiceInput") {inputFields {name type {kind name ofType {kind name}}}}
}`);
console.log(JSON.stringify({
  mutations: schema.__schema.mutationType.fields.filter((f: any) => /productionFileDelete|invoiceUpdate|taskUpdate/.test(f.name)),
  invoice: schema.invoiceType.fields.filter((f: any) => /productionFiles|tasks|customer|status|lineItemGroups/.test(f.name)),
  statusInput: schema.invoiceInput.inputFields.filter((f:any)=>/status/i.test(f.name)),
},null,2));
const probe:any=await client.query(`query {invoices(first:1) {nodes {id}}}`);
if(probe.invoices.nodes[0]) {
  const id=JSON.stringify(probe.invoices.nodes[0].id);
  const live:any=await client.query(`query {invoice(id:${id}) {
    id visualId nickname status {id name} contact {id fullName customer {id companyName}}
    productionFiles(first:50) {nodes {id name fileUrl timestamps {updatedAt createdAt}} pageInfo {hasNextPage endCursor}}
    tasks(first:50) {nodes {id name completed} pageInfo {hasNextPage endCursor}}
  }}`);
  console.log("Read-only live intake query verified:",Boolean(live.invoice?.productionFiles && live.invoice?.tasks));
}
